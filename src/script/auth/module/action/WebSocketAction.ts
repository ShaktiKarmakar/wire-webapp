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

import * as Events from '@wireapp/api-client/lib/event/';
import {ConnectionState, HttpClient} from '@wireapp/api-client/lib/http/';
import {PayloadBundle, PayloadBundleType} from '@wireapp/core/lib/conversation/';
import type {UserUpdateMessage} from '@wireapp/core/lib/conversation/message/UserMessage';
import {UserMapper} from '@wireapp/core/lib/user/UserMapper';

import {getLogger} from 'Util/Logger';

import type {ThunkAction} from '../../module/reducer';
import * as SelfSelector from '../../module/selector/SelfSelector';

export class WebSocketAction {
  private readonly logger = getLogger('WebSocketAction');

  listen = (): ThunkAction => {
    return async (dispatch, getState, {apiClient, core, actions: {selfAction}}) => {
      apiClient.transport.http.removeAllListeners(HttpClient.TOPIC.ON_CONNECTION_STATE_CHANGE);
      apiClient.transport.http.on(HttpClient.TOPIC.ON_CONNECTION_STATE_CHANGE, (event: ConnectionState) => {
        this.logger.log(
          `Connection state change ${HttpClient.TOPIC.ON_CONNECTION_STATE_CHANGE} message: ${JSON.stringify(event)}`,
        );
      });

      await core.listen({
        // We just want to get unencrypted backend events, so we use a dry run in order not to store the last notificationId and avoid decrypting events
        dryRun: true,
        onEvent: async ({event}, source) => {
          let data: PayloadBundle | void;
          try {
            switch (event.type) {
              case Events.USER_EVENT.UPDATE: {
                data = UserMapper.mapUserEvent(event, apiClient.context!.userId, source);
              }
              // Note: We do not want to update the last message timestamp
            }
          } catch (error) {
            this.logger.error(`There was an error with event ID "${event.type}": ${error.message}`, error);
          }
          if (data) {
            switch (data.type) {
              case PayloadBundleType.USER_UPDATE:
                const message = data as UserUpdateMessage;
                const isSelfId = message.content.user.id === SelfSelector.getSelf(getState()).id;
                if (isSelfId) {
                  await dispatch(selfAction.fetchSelf());
                }
                break;
            }
          }
        },
      });
    };
  };
}

export const webSocketAction = new WebSocketAction();
