/*
 * Wire
 * Copyright (C) 2018 Wire Swiss GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see http://www.gnu.org/licenses/.
 *
 */

import {Asset as ProtobufAsset} from '@wireapp/protocol-messaging';
import {WebAppEvents} from '@wireapp/webapp-events';
import {USER_EVENT} from '@wireapp/api-client/dist/event';
import {StatusCodes as HTTP_STATUS} from 'http-status-codes';
import {amplify} from 'amplify';
import ko from 'knockout';
import {CONVERSATION_EVENT} from '@wireapp/api-client/dist/event';
import type {Notification} from '@wireapp/api-client/dist/notification';

import {getLogger, Logger} from 'Util/Logger';
import {TIME_IN_MILLIS} from 'Util/TimeUtil';
import {t} from 'Util/LocalizerUtil';

import {CALL_MESSAGE_TYPE} from '../calling/enum/CallMessageType';
import {AssetTransferState} from '../assets/AssetTransferState';

import {EVENT_TYPE} from './EventType';
import {ClientEvent} from './Client';
import {EventTypeHandling} from './EventTypeHandling';
import {NOTIFICATION_HANDLING_STATE} from './NotificationHandlingState';
import {WarningsViewModel} from '../view_model/WarningsViewModel';
import {categoryFromEvent} from '../message/MessageCategorization';
import {EventSource} from './EventSource';
import {EventValidation} from './EventValidation';
import {validateEvent} from './EventValidator';
import {ConversationError} from '../error/ConversationError';
import {CryptographyError} from '../error/CryptographyError';
import {EventError} from '../error/EventError';
import type {EventService} from './EventService';
import type {WebSocketService, CHANGE_TRIGGER} from './WebSocketService';
import type {CryptographyRepository} from '../cryptography/CryptographyRepository';
import type {ServerTimeHandler} from '../time/serverTimeHandler';
import type {UserRepository} from '../user/UserRepository';
import type {ClientEntity} from '../client/ClientEntity';
import type {EventRecord} from '../storage';
import type {NotificationService} from './NotificationService';

export class EventRepository {
  logger: Logger;
  currentClient: ko.Observable<ClientEntity>;
  notificationHandlingState: ko.Observable<NOTIFICATION_HANDLING_STATE>;
  previousHandlingState: NOTIFICATION_HANDLING_STATE;
  notificationsHandled: number;
  notificationsLoaded: ko.Observable<boolean>;
  notificationsPromises: [(value?: unknown) => void, (value?: unknown) => void];
  notificationsTotal: number;
  notificationsQueue: ko.ObservableArray<Notification>;
  lastNotificationId: ko.Observable<string>;
  notificationsBlocked: boolean;
  webSocketBuffer: Notification[];
  lastEventDate: ko.Observable<string>;
  eventProcessMiddlewares: Function[];

  static get CONFIG() {
    return {
      E_CALL_EVENT_LIFETIME: TIME_IN_MILLIS.SECOND * 30,
      IGNORED_ERRORS: [
        CryptographyError.TYPE.IGNORED_ASSET,
        CryptographyError.TYPE.IGNORED_PREVIEW,
        CryptographyError.TYPE.PREVIOUSLY_STORED,
        CryptographyError.TYPE.UNHANDLED_TYPE,
        EventError.TYPE.OUTDATED_E_CALL_EVENT,
        EventError.TYPE.VALIDATION_FAILED,
      ],
      NOTIFICATION_BATCHES: {
        INITIAL: 500,
        MAX: 10000,
        SUBSEQUENT: 5000,
      },
    };
  }

  // TODO: Will be replaced with "EventSource"
  static get SOURCE() {
    return {
      BACKEND_RESPONSE: EventSource.BACKEND_RESPONSE,
      INJECTED: EventSource.INJECTED,
      STREAM: EventSource.STREAM,
      WEB_SOCKET: EventSource.WEB_SOCKET,
    };
  }

  constructor(
    readonly eventService: EventService,
    readonly notificationService: NotificationService,
    private readonly webSocketService: WebSocketService,
    private readonly cryptographyRepository: CryptographyRepository,
    private readonly serverTimeHandler: ServerTimeHandler,
    private readonly userRepository: UserRepository,
  ) {
    this.logger = getLogger('EventRepository');

    this.currentClient = undefined;

    this.notificationHandlingState = ko.observable(NOTIFICATION_HANDLING_STATE.STREAM);
    this.notificationHandlingState.subscribe(handling_state => {
      amplify.publish(WebAppEvents.EVENT.NOTIFICATION_HANDLING_STATE, handling_state);

      const isHandlingWebSocket = handling_state === NOTIFICATION_HANDLING_STATE.WEB_SOCKET;
      if (isHandlingWebSocket) {
        this._handleBufferedNotifications();
        const previouslyHandlingRecovery = this.previousHandlingState === NOTIFICATION_HANDLING_STATE.RECOVERY;
        if (previouslyHandlingRecovery) {
          amplify.publish(WebAppEvents.WARNING.DISMISS, WarningsViewModel.TYPE.CONNECTIVITY_RECOVERY);
        }
      }
      this.previousHandlingState = handling_state;
    });

    this.previousHandlingState = this.notificationHandlingState();

    this.notificationsHandled = 0;
    this.notificationsLoaded = ko.observable(false);
    this.notificationsPromises = undefined;
    this.notificationsTotal = 0;
    this.notificationsQueue = ko.observableArray([]);
    this.notificationsBlocked = false;

    this.notificationsQueue.subscribe((notifications): Promise<void> | void => {
      if (notifications.length) {
        if (this.notificationsBlocked) {
          return;
        }

        const [notification] = notifications;
        this.notificationsBlocked = true;

        return this._handleNotification(notification)
          .catch(error => {
            const errorMessage = `We failed to handle notification ID '${notification.id}' but will continue to process queued notifications. Error: ${error.message}`;
            this.logger.warn(errorMessage, error);
          })
          .then(() => {
            this.notificationsBlocked = false;
            this.notificationsQueue.shift();
            this.notificationsHandled++;

            const isHandlingStream = this.notificationHandlingState() === NOTIFICATION_HANDLING_STATE.STREAM;
            if (isHandlingStream) {
              this._updateProgress();
            }
          });
      }

      const isHandlingWebSocket = this.notificationHandlingState() === NOTIFICATION_HANDLING_STATE.WEB_SOCKET;
      if (this.notificationsLoaded() && !isHandlingWebSocket) {
        this.logger.info(`Done handling '${this.notificationsTotal}' notifications from the stream`);
        this.notificationHandlingState(NOTIFICATION_HANDLING_STATE.WEB_SOCKET);
        this.notificationsLoaded(false);
        this.notificationsPromises[0](this.lastNotificationId());
      }
    });

    this.webSocketBuffer = [];

    this.lastNotificationId = ko.observable();
    this.lastEventDate = ko.observable();

    this.eventProcessMiddlewares = [];

    amplify.subscribe(WebAppEvents.CONNECTION.ONLINE, this.recoverFromStream.bind(this));
  }

  /**
   * Will set a middleware to run before the EventRepository actually processes the event.
   * Middleware is just a function with the following signature (Event) => Promise<Event>.
   *
   * @param middlewares middlewares to run when a new event is about to be processed
   */
  setEventProcessMiddlewares(middlewares: Function[]) {
    this.eventProcessMiddlewares = middlewares;
  }

  //##############################################################################
  // WebSocket handling
  //##############################################################################

  /**
   * Initiate the WebSocket connection.
   * @returns {undefined} No return value
   */
  async connectWebSocket() {
    if (!this.currentClient().id) {
      throw new EventError(EventError.TYPE.NO_CLIENT_ID, EventError.MESSAGE.NO_CLIENT_ID);
    }

    this.webSocketService.clientId = this.currentClient().id;
    await this.webSocketService.connect((notification): number | void => {
      const isHandlingWebSocket = this.notificationHandlingState() === NOTIFICATION_HANDLING_STATE.WEB_SOCKET;
      if (isHandlingWebSocket) {
        return this.notificationsQueue.push(notification);
      }
      this._bufferWebSocketNotification(notification);
    });
  }

  /**
   * Close the WebSocket connection.
   * @param trigger Trigger of the disconnect
   */
  disconnectWebSocket(trigger: CHANGE_TRIGGER) {
    this.webSocketService.reset(trigger);
  }

  /**
   * Re-connect the WebSocket connection.
   * @param trigger Trigger of the reconnect
   * @returns No return value
   */
  reconnectWebSocket(trigger: CHANGE_TRIGGER) {
    this.notificationHandlingState(NOTIFICATION_HANDLING_STATE.RECOVERY);
    this.webSocketService.reconnect(trigger);
  }

  _bufferWebSocketNotification(notification: Notification) {
    this.webSocketBuffer.push(notification);
  }

  /**
   * Handle buffered notifications.
   */
  _handleBufferedNotifications() {
    this.logger.info(`Received '${this.webSocketBuffer.length}' notifications via WebSocket while handling stream`);
    if (this.webSocketBuffer.length) {
      this.notificationsQueue.push(...this.webSocketBuffer);
      this.webSocketBuffer.length = 0;
    }
  }

  //##############################################################################
  // Notification Stream handling
  //##############################################################################
  async _handleTimeDrift() {
    try {
      const time = await this.notificationService.getServerTime();
      this.serverTimeHandler.computeTimeOffset(time);
    } catch (errorResponse) {
      if (errorResponse.response?.time) {
        this.serverTimeHandler.computeTimeOffset(errorResponse.response?.time);
      }
    }
  }
  /**
   * Get notifications for the current client from the stream.
   *
   * @param notificationId Event ID to start from
   * @param [limit=EventRepository.CONFIG.NOTIFICATION_BATCHES.MAX] Max. number of notifications to retrieve from backend at once
   * @returns Resolves when all new notifications from the stream have been handled
   */
  async getNotifications(notificationId: string, limit = EventRepository.CONFIG.NOTIFICATION_BATCHES.MAX) {
    const processNotifications = (notifications: Notification[]) => {
      if (notifications.length <= 0) {
        this.logger.info(`No notifications found since '${notificationId}'`);
        this.notificationsLoaded(true);
        this.notificationsQueue.push(...notifications);
        return notificationId;
      }

      notificationId = notifications[notifications.length - 1].id;

      this.logger.info(`Added '${notifications.length}' notifications to the queue`);
      this.notificationsQueue.push(...notifications);

      this.notificationsTotal += notifications.length;

      this.notificationsLoaded(true);
      this.logger.info(`Fetched '${this.notificationsTotal}' notifications from the backend`);
      return notificationId;
    };

    await this._handleTimeDrift();

    try {
      const notificationList = await this.notificationService.getAllNotificationsForClient(
        this.currentClient().id,
        notificationId,
      );
      // Note: `resolve` handle is needed to delay notification handling until buffered notifications from websocket are processed.
      return new Promise((resolve, reject) => {
        try {
          this.notificationsPromises = [resolve, reject];
          processNotifications(notificationList);
        } catch (error) {
          reject(error);
        }
      });
    } catch (errorResponse) {
      // When asking for /notifications with a `since` set to a notification ID that the backend doesn't know of (because it does not belong to our client or it is older than the lifetime of the notification stream),
      // we will receive a HTTP 404 status code with a `notifications` payload
      // TODO: In the future we should ask the backend for the last known notification id (HTTP GET /notifications/{id}) instead of using the "errorResponse.notifications" payload
      if (errorResponse.response?.notifications) {
        this._triggerMissedSystemEventMessageRendering();
        return new Promise((resolve, reject) => {
          try {
            this.notificationsPromises = [resolve, reject];
            processNotifications(errorResponse.response?.notifications);
          } catch (error) {
            reject(error);
          }
        });
      }

      const isNotFound = errorResponse.response?.status === HTTP_STATUS.NOT_FOUND;
      if (isNotFound) {
        this.logger.info(`No notifications found since '${notificationId}'`, errorResponse);
        throw new EventError(EventError.TYPE.NO_NOTIFICATIONS, EventError.MESSAGE.NO_NOTIFICATIONS);
      }

      this.logger.error(`Failed to get notifications: ${errorResponse.message}`, errorResponse);
      throw new EventError(EventError.TYPE.REQUEST_FAILURE, EventError.MESSAGE.REQUEST_FAILURE);
    }
  }

  /**
   * Get the last notification.
   * @returns {Promise<{eventDate: string, notificationId: string}>} Resolves with the last handled notification ID and time
   */
  getStreamState() {
    return this.notificationService
      .getLastNotificationIdFromDb()
      .catch(error => {
        const isNoLastId = error.type === EventError.TYPE.NO_LAST_ID;
        if (!isNoLastId) {
          throw error;
        }

        this.logger.warn('Last notification ID not found in database. Resetting...');
        return this.setStreamState(this.currentClient().id).then(() => {
          this._triggerMissedSystemEventMessageRendering();
          return this.lastNotificationId();
        });
      })
      .then(notificationId => {
        this.lastNotificationId(notificationId);
        return this.notificationService.getLastEventDateFromDb();
      })
      .then(eventDate => this.lastEventDate(eventDate))
      .catch(error => {
        const isNoLastDate = error.type === EventError.TYPE.NO_LAST_DATE;
        if (!isNoLastDate) {
          throw error;
        }

        this.logger.warn('Last event date not found in database. Resetting...');
        this.lastEventDate(new Date(0).toISOString());
      })
      .then(() => ({eventDate: this.lastEventDate(), notificationId: this.lastNotificationId()}));
  }

  /**
   * Set state for notification stream.
   * @returns {Promise} Resolves when all notifications have been handled
   */
  async initializeFromStream() {
    try {
      const {notificationId} = await this.getStreamState();
      return this._updateFromStream(notificationId);
    } catch (error) {
      this.notificationHandlingState(NOTIFICATION_HANDLING_STATE.WEB_SOCKET);

      const isNoLastId = error.type === EventError.TYPE.NO_LAST_ID;
      if (isNoLastId) {
        this.logger.info('No notifications found for this user', error);
        return 0;
      }

      throw error;
    }
  }

  /**
   * Retrieve missed notifications from the stream after a connectivity loss.
   * @returns {Promise} Resolves when all missed notifications have been handled
   */
  recoverFromStream() {
    const lastNotificationId = this._getLastKnownNotificationId();
    this.logger.warn(
      `Recovering from notification stream (after connectivity loss) with notification ID '${lastNotificationId}'...`,
    );
    this.notificationHandlingState(NOTIFICATION_HANDLING_STATE.RECOVERY);
    amplify.publish(WebAppEvents.WARNING.SHOW, WarningsViewModel.TYPE.CONNECTIVITY_RECOVERY);

    return this._updateFromStream(lastNotificationId)
      .then(numberOfNotifications => {
        this.logger.info(`Retrieved '${numberOfNotifications}' notifications from stream after connectivity loss`);
      })
      .catch(error => {
        const isNoNotifications = error.type === EventError.TYPE.NO_NOTIFICATIONS;
        if (!isNoNotifications) {
          this.logger.error(`Failed to recover from notification stream: ${error.message}`, error);
          this.notificationHandlingState(NOTIFICATION_HANDLING_STATE.WEB_SOCKET);
          // @todo What do we do in this case?
          amplify.publish(WebAppEvents.WARNING.SHOW, WarningsViewModel.TYPE.CONNECTIVITY_RECONNECT);
        }
      });
  }

  /**
   * Get the last notification ID and set event date for a given client.
   *
   * @param clientId Client ID to retrieve last notification ID for
   * @param [isInitialization=false] Set initial date to 0 if not found
   * @returns Resolves when stream state has been initialized
   */
  setStreamState(clientId: string, isInitialization = false) {
    return this.notificationService.getNotificationsLast(clientId).then(
      ({id: notificationId, payload}): Promise<(string | void)[]> => {
        const [event] = payload;
        const isoDateString = this._getIsoDateFromEvent(event as EventRecord, isInitialization) as string;

        if (notificationId) {
          const logMessage = isoDateString
            ? `Set starting point on notification stream to '${notificationId}' (isoDateString)`
            : `Reset starting point on notification stream to '${notificationId}'`;
          this.logger.info(logMessage);

          return Promise.all([
            this._updateLastEventDate(isoDateString),
            this._updateLastNotificationId(notificationId),
          ]);
        }

        return undefined;
      },
    );
  }

  _getIsoDateFromEvent(event: EventRecord, defaultValue = false): string | void {
    const {client, connection, time: eventDate, type: eventType} = event;

    if (eventDate) {
      return eventDate;
    }

    const isTypeUserClientAdd = eventType === USER_EVENT.CLIENT_ADD;
    if (isTypeUserClientAdd) {
      return client.time;
    }

    const isTypeUserConnection = eventType === USER_EVENT.CONNECTION;
    if (isTypeUserConnection) {
      return connection.lastUpdate;
    }

    if (defaultValue) {
      return new Date(0).toISOString();
    }
  }

  /**
   * Get the ID of the last known notification.
   * @note Notifications that have not yet been handled but are in the queue should not be fetched again on recovery
   *
   * @returns ID of last known notification
   */
  private _getLastKnownNotificationId() {
    return this.notificationsQueue().length
      ? this.notificationsQueue()[this.notificationsQueue().length - 1].id
      : this.lastNotificationId();
  }

  _triggerMissedSystemEventMessageRendering() {
    this.notificationService.getMissedIdFromDb().then(notificationId => {
      const shouldUpdatePersistedId = this.lastNotificationId() !== notificationId;
      if (shouldUpdatePersistedId) {
        amplify.publish(WebAppEvents.CONVERSATION.MISSED_EVENTS);
        this.notificationService.saveMissedIdToDb(this.lastNotificationId());
      }
    });
  }

  /**
   * Fetch all missed events from the notification stream since the given last notification ID.
   *
   * @param lastNotificationId Last known notification ID to start update from
   * @returns Resolves with the total number of notifications
   */
  private async _updateFromStream(lastNotificationId: string) {
    this.notificationsTotal = 0;

    try {
      const updatedLastNotificationId = await this.getNotifications(
        lastNotificationId,
        EventRepository.CONFIG.NOTIFICATION_BATCHES.INITIAL,
      );
      if (updatedLastNotificationId) {
        this.logger.info(`ID of last notification fetched from stream is '${updatedLastNotificationId}'`);
      }
      return this.notificationsTotal;
    } catch (error) {
      this.notificationHandlingState(NOTIFICATION_HANDLING_STATE.WEB_SOCKET);

      const isNoNotifications = error.type === EventError.TYPE.NO_NOTIFICATIONS;
      if (isNoNotifications) {
        this.logger.info('No notifications found for this user', error);
        return 0;
      }

      this.logger.error(`Failed to handle notification stream: ${error.message}`, error);
      throw error;
    }
  }

  /**
   * Persist updated last event timestamp.
   *
   * @param eventDate Updated last event date
   * @returns Resolves when the last event date was stored
   */
  private _updateLastEventDate(eventDate: string): Promise<string> | void {
    const didDateIncrease = eventDate > this.lastEventDate();
    if (didDateIncrease) {
      this.lastEventDate(eventDate);
      return this.notificationService.saveLastEventDateToDb(eventDate);
    }
  }

  /**
   * Persist updated last notification ID.
   *
   * @param notificationId Updated last notification ID
   * @returns Resolves when the last notification ID was stored
   */
  private _updateLastNotificationId(notificationId: string): Promise<string | void> {
    if (notificationId) {
      this.lastNotificationId(notificationId);
      return this.notificationService.saveLastNotificationIdToDb(notificationId);
    }
    return Promise.resolve();
  }

  _updateProgress() {
    if (this.notificationsHandled % 5 === 0 || this.notificationsHandled < 5) {
      const content = {
        handled: this.notificationsHandled,
        total: this.notificationsTotal,
      };
      const progress = (this.notificationsHandled / this.notificationsTotal) * 50 + 25;

      amplify.publish(WebAppEvents.APP.UPDATE_PROGRESS, progress, t('initDecryption'), content);
    }
  }

  //##############################################################################
  // Notification/Event handling
  //##############################################################################

  /**
   * Inject event into a conversation.
   * @note Don't add unable to decrypt to self conversation
   *
   * @param event Event payload to be injected
   * @param [source=EventRepository.SOURCE.INJECTED] Source of injection
   * @returns Resolves when the event has been processed
   */
  injectEvent(event: EventRecord, source = EventRepository.SOURCE.INJECTED) {
    if (!event) {
      throw new EventError(EventError.TYPE.NO_EVENT, EventError.MESSAGE.NO_EVENT);
    }

    const isHandlingWebSocket = this.notificationHandlingState() === NOTIFICATION_HANDLING_STATE.WEB_SOCKET;
    if (!isHandlingWebSocket) {
      source = EventRepository.SOURCE.INJECTED;
    }

    const {conversation: conversationId, id = 'ID not specified', type} = event;
    const inSelfConversation = conversationId === this.userRepository.self().id;
    if (!inSelfConversation) {
      this.logger.info(`Injected event ID '${id}' of type '${type}' with source '${source}'`, event);
      return this._handleEvent(event, source);
    }
    return Promise.resolve(event);
  }

  /**
   * Distribute the given event.
   *
   * @param event Mapped event to be distributed
   * @param source Source of notification
   */
  private _distributeEvent(event: EventRecord, source: EventSource) {
    const {conversation: conversationId, from: userId, type} = event;

    const hasIds = conversationId && userId;
    const logMessage = hasIds
      ? `Distributed '${type}' event for conversation '${conversationId}' from user '${userId}'`
      : `Distributed '${type}' event`;
    this.logger.info(logMessage, event);

    const [category] = type.split('.');
    switch (category) {
      case EVENT_TYPE.CALL:
        amplify.publish(WebAppEvents.CALL.EVENT_FROM_BACKEND, event, source);
        break;
      case EVENT_TYPE.CONVERSATION:
        amplify.publish(WebAppEvents.CONVERSATION.EVENT_FROM_BACKEND, event, source);
        break;
      case EVENT_TYPE.TEAM:
        amplify.publish(WebAppEvents.TEAM.EVENT_FROM_BACKEND, event, source);
        break;
      case EVENT_TYPE.USER:
        amplify.publish(WebAppEvents.USER.EVENT_FROM_BACKEND, event, source);
        break;
      default:
        amplify.publish(type, event, source);
    }
  }

  /**
   * Handle a single event from the notification stream or WebSocket.
   *
   * @param event Event coming from backend
   * @param source Source of event
   * @returns Resolves with the saved record or the plain event if the event was skipped
   */
  _handleEvent(event: EventRecord, source: EventSource) {
    const logObject = {eventJson: JSON.stringify(event), eventObject: event};
    const validationResult = validateEvent(
      event as {time: string; type: CONVERSATION_EVENT | USER_EVENT},
      source,
      this.lastEventDate(),
    );
    switch (validationResult) {
      default: {
        return Promise.resolve(event);
      }
      case EventValidation.IGNORED_TYPE: {
        this.logger.info(`Ignored event type '${event.type}'`, logObject);
        return Promise.resolve(event);
      }
      case EventValidation.OUTDATED_TIMESTAMP: {
        this.logger.info(`Ignored outdated event type: '${event.type}'`, logObject);
        return Promise.resolve(event);
      }
      case EventValidation.VALID:
        return this.processEvent(event, source);
    }
  }

  /**
   * Decrypts, saves and distributes an event received from the backend.
   *
   * @param event Backend event extracted from notification stream
   * @param source Source of event
   * @returns Resolves with the saved record or `true` if the event was skipped
   */
  async processEvent(event: EventRecord, source: EventSource) {
    const isEncryptedEvent = event.type === CONVERSATION_EVENT.OTR_MESSAGE_ADD;
    if (isEncryptedEvent) {
      event = await this.cryptographyRepository.handleEncryptedEvent(event);
    }

    for (const eventProcessMiddleware of this.eventProcessMiddlewares) {
      event = await eventProcessMiddleware(event);
    }

    const shouldSaveEvent = EventTypeHandling.STORE.includes(event.type as CONVERSATION_EVENT);
    if (shouldSaveEvent) {
      event = (await this._handleEventSaving(event)) as EventRecord;
    }

    return this._handleEventDistribution(event, source);
  }

  /**
   * Handle a saved event and distribute it.
   *
   * @param event Backend event extracted from notification stream
   * @param source Source of event
   * @returns The distributed event
   */
  private _handleEventDistribution(event: EventRecord, source: EventSource) {
    const eventDate = this._getIsoDateFromEvent(event);
    const isInjectedEvent = source === EventRepository.SOURCE.INJECTED;
    const canSetEventDate = !isInjectedEvent && eventDate;
    if (canSetEventDate) {
      /*
       * HOTFIX: The "conversation.voice-channel-deactivate" event is the ONLY event which we inject with a source set to WebSocket.
       * This is wrong but changing it will break our current conversation archive functionality (WEBAPP-6435).
       * That's why we need to explicitly list the "conversation.voice-channel-deactivate" here because injected events should NEVER
       * modify the last event timestamp which we use to query the backend's notification stream.
       */
      if (event.type !== ClientEvent.CONVERSATION.VOICE_CHANNEL_DEACTIVATE) {
        this._updateLastEventDate(eventDate as string);
      }
    }

    const isCallEvent = event.type === ClientEvent.CALL.E_CALL;
    if (isCallEvent) {
      this._validateCallEventLifetime(event);
    }

    this._distributeEvent(event, source);

    return event;
  }

  /**
   * Handle a mapped event, check for malicious ID use and save it.
   *
   * @param event Backend event extracted from notification stream
   * @returns Resolves with the saved event
   */
  private _handleEventSaving(event: EventRecord) {
    const conversationId = event.conversation;
    const mappedData = event.data || {};

    // first check if a message that should be replaced exists in DB
    const findEventToReplacePromise = mappedData.replacing_message_id
      ? this.eventService.loadEvent(conversationId, mappedData.replacing_message_id)
      : Promise.resolve();

    return (findEventToReplacePromise as Promise<EventRecord>).then((eventToReplace: EventRecord) => {
      const hasLinkPreview = mappedData.previews && mappedData.previews.length;
      const isReplacementWithoutOriginal = !eventToReplace && mappedData.replacing_message_id;
      if (isReplacementWithoutOriginal && !hasLinkPreview) {
        // the only valid case of a replacement with no original message is when an edited message gets a link preview
        this._throwValidationError(event, 'Edit event without original event');
      }

      const handleEvent = (newEvent: EventRecord) => {
        // check for duplicates (same id)
        const loadEventPromise = newEvent.id
          ? this.eventService.loadEvent(conversationId, newEvent.id)
          : Promise.resolve();

        return (loadEventPromise as Promise<EventRecord>).then((storedEvent: EventRecord) => {
          return storedEvent
            ? this._handleDuplicatedEvent(storedEvent, newEvent)
            : this.eventService.saveEvent(newEvent);
        });
      };

      return eventToReplace ? this._handleEventReplacement(eventToReplace, event) : handleEvent(event);
    });
  }

  _handleEventReplacement(originalEvent: EventRecord, newEvent: EventRecord) {
    const newData = newEvent.data || {};
    if (originalEvent.data.from !== newData.from) {
      const logMessage = `ID previously used by user '${newEvent.from}'`;
      const errorMessage = 'ID reused by other user';
      this._throwValidationError(newEvent, errorMessage, logMessage);
    }
    const primaryKeyUpdate = {primary_key: originalEvent.primary_key};
    const isLinkPreviewEdit = newData.previews && !!newData.previews.length;

    const commonUpdates = this._getCommonMessageUpdates(originalEvent, newEvent);

    const specificUpdates = isLinkPreviewEdit
      ? this._getUpdatesForLinkPreview(originalEvent, newEvent)
      : this._getUpdatesForEditMessage(originalEvent, newEvent);

    const updates = {...specificUpdates, ...commonUpdates};

    const identifiedUpdates = {...primaryKeyUpdate, ...updates};
    return this.eventService.replaceEvent(identifiedUpdates);
  }

  _handleDuplicatedEvent(originalEvent: EventRecord, newEvent: EventRecord) {
    switch (newEvent.type) {
      case ClientEvent.CONVERSATION.ASSET_ADD:
        return this._handleAssetUpdate(originalEvent, newEvent);

      case ClientEvent.CONVERSATION.MESSAGE_ADD:
        return this._handleLinkPreviewUpdate(originalEvent, newEvent);

      default:
        this._throwValidationError(newEvent, `Forbidden type '${newEvent.type}' for duplicate events`);
    }
  }

  _handleAssetUpdate(originalEvent: EventRecord, newEvent: EventRecord) {
    const newEventData = newEvent.data;
    // the preview status is not sent by the client so we fake a 'preview' status in order to cleanly handle it in the switch statement
    const ASSET_PREVIEW = 'preview';
    const isPreviewEvent = !newEventData.status && newEventData.preview_key;
    const status = isPreviewEvent ? ASSET_PREVIEW : newEventData.status;

    switch (status) {
      case ASSET_PREVIEW:
      case AssetTransferState.UPLOADED: {
        const updatedData = {...originalEvent.data, ...newEventData};
        const updatedEvent = {...originalEvent, data: updatedData};
        return this.eventService.replaceEvent(updatedEvent);
      }

      case AssetTransferState.UPLOAD_FAILED: {
        // case of both failed or canceled upload
        const fromOther = newEvent.from !== this.userRepository.self().id;
        const selfCancel = !fromOther && newEvent.data.reason === ProtobufAsset.NotUploaded.CANCELLED;
        // we want to delete the event in the case of an error from the remote client or a cancel on the user's own client
        const shouldDeleteEvent = fromOther || selfCancel;
        return shouldDeleteEvent
          ? this.eventService.deleteEvent(newEvent.conversation, newEvent.id).then(() => newEvent)
          : this.eventService.updateEventAsUploadFailed(originalEvent.primary_key, newEvent.data.reason);
      }

      default:
        return this._throwValidationError(newEvent, `Unhandled asset status update '${newEvent.data.status}'`);
    }
  }

  _handleLinkPreviewUpdate(originalEvent: EventRecord, newEvent: EventRecord) {
    const newEventData = newEvent.data;
    const originalData = originalEvent.data;
    if (originalEvent.from !== newEvent.from) {
      const logMessage = `ID previously used by user '${newEvent.from}'`;
      const errorMessage = 'ID reused by other user';
      return this._throwValidationError(newEvent, errorMessage, logMessage);
    }

    const containsLinkPreview = newEventData.previews && !!newEventData.previews.length;
    if (!containsLinkPreview) {
      const errorMessage = 'Link preview event does not contain previews';
      return this._throwValidationError(newEvent, errorMessage);
    }

    const textContentMatches = newEventData.content === originalData.content;
    if (!textContentMatches) {
      const errorMessage = 'ID of link preview reused';
      const logMessage = 'Text content for link preview not matching';
      return this._throwValidationError(newEvent, errorMessage, logMessage);
    }

    const bothAreMessageAddType = newEvent.type === originalEvent.type;
    if (!bothAreMessageAddType) {
      return this._throwValidationError(newEvent, 'ID reused by same user');
    }

    const updates = this._getUpdatesForLinkPreview(originalEvent, newEvent);
    const identifiedUpdates = {primary_key: originalEvent.primary_key, ...updates};
    return this.eventService.replaceEvent(identifiedUpdates);
  }

  _getCommonMessageUpdates(originalEvent: EventRecord, newEvent: EventRecord) {
    return {
      ...newEvent,
      data: {...newEvent.data, expects_read_confirmation: originalEvent.data.expects_read_confirmation},
      edited_time: newEvent.time,
      time: originalEvent.time,
      version: 1,
    };
  }

  _getUpdatesForEditMessage(originalEvent: EventRecord, newEvent: EventRecord) {
    return {...newEvent, reactions: {}};
  }

  _getUpdatesForLinkPreview(originalEvent: EventRecord, newEvent: EventRecord) {
    const newData = newEvent.data;
    const originalData = originalEvent.data;
    const updatingLinkPreview = !!originalData.previews.length;
    if (updatingLinkPreview) {
      this._throwValidationError(newEvent, 'ID of link preview reused');
    }

    const textContentMatches = !newData.previews.length || newData.content === originalData.content;
    if (!textContentMatches) {
      const logMessage = 'Text content for link preview not matching';
      const errorMessage = 'ID of link preview reused';
      this._throwValidationError(newEvent, errorMessage, logMessage);
    }

    return {
      ...newEvent,
      category: categoryFromEvent(newEvent),
      ephemeral_expires: originalEvent.ephemeral_expires,
      ephemeral_started: originalEvent.ephemeral_started,
      ephemeral_time: originalEvent.ephemeral_time,
      server_time: newEvent.time,
      time: originalEvent.time,
      version: originalEvent.version,
    };
  }

  _throwValidationError(event: EventRecord, errorMessage: string, logMessage?: string) {
    const baseLogMessage = `Ignored '${event.type}' (${event.id}) in '${event.conversation}' from '${event.from}':'`;
    const baseErrorMessage = 'Event validation failed:';
    this.logger.warn(`${baseLogMessage} ${logMessage || errorMessage}`, event);
    throw new EventError(EventError.TYPE.VALIDATION_FAILED, `${baseErrorMessage} ${errorMessage}`);
  }

  /**
   * Handle all events from the payload of an incoming notification.
   *
   * @param events Events contained in a notification
   * @param id Notification ID
   * @param transient Type of notification
   * @returns Resolves with the ID of the handled notification
   */
  private _handleNotification({payload: events, id, transient}: Notification): Promise<string | void> {
    const source = transient !== undefined ? EventRepository.SOURCE.WEB_SOCKET : EventRepository.SOURCE.STREAM;
    const isTransientEvent = !!transient;
    this.logger.info(`Handling notification '${id}' from '${source}' containing '${events.length}' events`, events);

    if (!events.length) {
      this.logger.warn('Notification payload does not contain any events');
      return isTransientEvent ? Promise.resolve(id) : this._updateLastNotificationId(id);
    }

    return Promise.all(events.map(event => this._handleEvent(event as EventRecord, source)))
      .then(() => (isTransientEvent ? id : this._updateLastNotificationId(id)))
      .catch(error => {
        if (error.type === ConversationError.TYPE.CONVERSATION_NOT_FOUND) {
          return;
        }
        this.logger.error(`Failed to handle notification '${id}' from '${source}': ${error.message}`, error);
        throw error;
      });
  }

  /**
   * Check if call event is handled within its valid lifespan.
   *
   * @param event Event to validate
   * @returns `true` if event is handled within it's lifetime, otherwise throws error
   */
  private _validateCallEventLifetime(event: EventRecord): boolean {
    const {content = {}, conversation: conversationId, time, type} = event;
    const forcedEventTypes = [CALL_MESSAGE_TYPE.CANCEL, CALL_MESSAGE_TYPE.GROUP_LEAVE];

    const correctedTimestamp = this.serverTimeHandler.toServerTimestamp();
    const thresholdTimestamp = new Date(time).getTime() + EventRepository.CONFIG.E_CALL_EVENT_LIFETIME;

    const isForcedEventType = forcedEventTypes.includes((content as {type: CALL_MESSAGE_TYPE}).type);
    const eventWithinThreshold = correctedTimestamp < thresholdTimestamp;
    const stateIsWebSocket = this.notificationHandlingState() === NOTIFICATION_HANDLING_STATE.WEB_SOCKET;

    const isValidEvent = isForcedEventType || eventWithinThreshold || stateIsWebSocket;
    if (isValidEvent) {
      return true;
    }

    const eventIsoDate = new Date(time).toISOString();
    const logMessage = `Ignored outdated calling event '${type}' (${eventIsoDate}) in conversation '${conversationId}'`;
    const logObject = {
      eventJson: JSON.stringify(event),
      eventObject: event,
      eventTime: eventIsoDate,
      localTime: new Date(correctedTimestamp).toISOString(),
    };
    this.logger.info(logMessage, logObject);
    throw new EventError(EventError.TYPE.OUTDATED_E_CALL_EVENT, EventError.MESSAGE.OUTDATED_E_CALL_EVENT);
  }
}