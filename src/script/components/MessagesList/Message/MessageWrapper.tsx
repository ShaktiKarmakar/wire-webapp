/*
 * Wire
 * Copyright (C) 2022 Wire Swiss GmbH
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

import React from 'react';

import {WebAppEvents} from '@wireapp/webapp-events';
import {amplify} from 'amplify';
import ko from 'knockout';
import {container} from 'tsyringe';

import {t} from 'Util/LocalizerUtil';

import {CallMessage} from './CallMessage';
import {CallTimeoutMessage} from './CallTimeoutMessage';
import {ContentMessageComponent} from './ContentMessage';
import {DecryptErrorMessage} from './DecryptErrorMessage';
import {DeleteMessage} from './DeleteMessage';
import {FileTypeRestrictedMessage} from './FileTypeRestrictedMessage';
import {LegalHoldMessage} from './LegalHoldMessage';
import {MemberMessage} from './MemberMessage';
import {MissedMessage} from './MissedMessage';
import {PingMessage} from './PingMessage';
import {SystemMessage} from './SystemMessage';
import {VerificationMessage} from './VerificationMessage';

import {AssetRepository} from '../../../assets/AssetRepository';
import {Conversation} from '../../../entity/Conversation';
import {CompositeMessage} from '../../../entity/message/CompositeMessage';
import {TeamState} from '../../../team/TeamState';
import {ContextMenuEntry} from '../../../ui/ContextMenu';

import {MessageParams} from './index';

export const MessageWrapper: React.FC<MessageParams & {hasMarker: boolean}> = ({
  message,
  conversation,
  selfId,
  hasMarker,
  isSelfTemporaryGuest,
  isLastDeliveredMessage,
  shouldShowInvitePeople,
  previousMessage,
  hasReadReceiptsTurnedOn,
  onClickAvatar,
  onClickImage,
  onClickInvitePeople,
  onClickLikes,
  onClickMessage,
  onClickTimestamp,
  onClickParticipants,
  onClickReceipts,
  onClickResetSession,
  onClickCancelRequest,
  onLike,
  messageRepository,
  messageActions,
  teamState = container.resolve(TeamState),
}) => {
  const findMessage = (conversation: Conversation, messageId: string) => {
    return messageRepository.getMessageInConversationById(conversation, messageId, true, true);
  };
  const clickButton = (message: CompositeMessage, buttonId: string) => {
    if (message.selectedButtonId() !== buttonId && message.waitingButtonId() !== buttonId) {
      message.waitingButtonId(buttonId);
      messageRepository.sendButtonAction(conversation, message, buttonId);
    }
  };

  const contextMenuEntries = ko.pureComputed(() => {
    const entries: ContextMenuEntry[] = [];

    const isRestrictedFileShare = !teamState.isFileSharingReceivingEnabled();

    const canDelete = message.user().isMe && !conversation.removed_from_conversation() && message.isDeletable();

    const canEdit = message.isEditable() && !conversation.removed_from_conversation();

    const hasDetails = !conversation.is1to1() && !message.isEphemeral() && !conversation.removed_from_conversation();

    if (message.isDownloadable() && !isRestrictedFileShare) {
      entries.push({
        click: () => message.download(container.resolve(AssetRepository)),
        label: t('conversationContextMenuDownload'),
      });
    }

    if (message.isReactable() && !conversation.removed_from_conversation()) {
      const label = message.is_liked() ? t('conversationContextMenuUnlike') : t('conversationContextMenuLike');

      entries.push({
        click: () => onLike(message, false),
        label,
      });
    }

    if (canEdit) {
      entries.push({
        click: () => amplify.publish(WebAppEvents.CONVERSATION.MESSAGE.EDIT, message),
        label: t('conversationContextMenuEdit'),
      });
    }

    if (message.isReplyable() && !conversation.removed_from_conversation()) {
      entries.push({
        click: () => amplify.publish(WebAppEvents.CONVERSATION.MESSAGE.REPLY, message),
        label: t('conversationContextMenuReply'),
      });
    }

    if (message.isCopyable() && !isRestrictedFileShare) {
      entries.push({
        click: () => message.copy(),
        label: t('conversationContextMenuCopy'),
      });
    }

    if (hasDetails) {
      entries.push({
        click: () => onClickReceipts(message),
        label: t('conversationContextMenuDetails'),
      });
    }

    if (message.isDeletable()) {
      entries.push({
        click: () => messageActions.deleteMessage(conversation, message),
        label: t('conversationContextMenuDelete'),
      });
    }

    if (canDelete) {
      entries.push({
        click: () => messageActions.deleteMessageEveryone(conversation, message),
        label: t('conversationContextMenuDeleteEveryone'),
      });
    }

    return entries;
  });

  if (message.isContent()) {
    return (
      <ContentMessageComponent
        message={message}
        findMessage={findMessage}
        conversation={conversation}
        previousMessage={previousMessage}
        hasMarker={hasMarker}
        selfId={selfId}
        isLastDeliveredMessage={isLastDeliveredMessage}
        onLike={onLike}
        onClickMessage={onClickMessage}
        onClickTimestamp={onClickTimestamp}
        onClickLikes={onClickLikes}
        onClickButton={clickButton}
        onClickAvatar={onClickAvatar}
        contextMenu={{entries: contextMenuEntries}}
        onClickCancelRequest={onClickCancelRequest}
        onClickImage={onClickImage}
        onClickInvitePeople={onClickInvitePeople}
        onClickParticipants={onClickParticipants}
        onClickReceipts={onClickReceipts}
      />
    );
  }
  if (message.isUnableToDecrypt()) {
    return <DecryptErrorMessage message={message} onClickResetSession={onClickResetSession} />;
  }
  if (message.isLegalHold()) {
    return <LegalHoldMessage message={message} />;
  }
  if (message.isVerification()) {
    return <VerificationMessage message={message} />;
  }
  if (message.isDelete()) {
    return <DeleteMessage message={message} onClickAvatar={onClickAvatar} />;
  }
  if (message.isCall()) {
    return <CallMessage message={message} />;
  }
  if (message.isCallTimeout()) {
    return <CallTimeoutMessage message={message} />;
  }
  if (message.isSystem()) {
    return <SystemMessage message={message} />;
  }
  if (message.isMember()) {
    return (
      <MemberMessage
        message={message}
        onClickInvitePeople={onClickInvitePeople}
        onClickParticipants={onClickParticipants}
        onClickCancelRequest={onClickCancelRequest}
        hasReadReceiptsTurnedOn={hasReadReceiptsTurnedOn}
        shouldShowInvitePeople={shouldShowInvitePeople}
        isSelfTemporaryGuest={isSelfTemporaryGuest}
        classifiedDomains={teamState.classifiedDomains()}
      />
    );
  }
  if (message.isPing()) {
    return (
      <PingMessage
        message={message}
        is1to1Conversation={conversation.is1to1()}
        isLastDeliveredMessage={isLastDeliveredMessage}
        onClickReceipts={onClickReceipts}
      />
    );
  }
  if (message.isFileTypeRestricted()) {
    return <FileTypeRestrictedMessage message={message} />;
  }
  if (message.isMissed()) {
    return <MissedMessage />;
  }
  return null;
};
