/*
 * Wire
 * Copyright (C) 2021 Wire Swiss GmbH
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

import React, {useEffect, useState} from 'react';

import {AudioPreference, NotificationPreference, WebappProperties} from '@wireapp/api-client/lib/user/data/';
import {Checkbox, CheckboxLabel} from '@wireapp/react-ui-kit';
import {WebAppEvents} from '@wireapp/webapp-events';
import {amplify} from 'amplify';
import {container} from 'tsyringe';

import {useKoSubscribableChildren} from 'Util/ComponentUtil';
import {t} from 'Util/LocalizerUtil';

import {PreferencesPage} from './components/PreferencesPage';
import {PreferencesRadio} from './components/PreferencesRadio';
import {PreferencesSection} from './components/PreferencesSection';

import {PropertiesRepository} from '../../../../properties/PropertiesRepository';
import {PROPERTIES_TYPE} from '../../../../properties/PropertiesType';
import {UserState} from '../../../../user/UserState';
import {THEMES as ThemeViewModelThemes} from '../../../../view_model/ThemeViewModel';

interface OptionPreferencesProps {
  propertiesRepository: PropertiesRepository;
  userState?: UserState;
}

const OptionPreferences: React.FC<OptionPreferencesProps> = ({
  propertiesRepository,
  userState = container.resolve(UserState),
}) => {
  const {isActivatedAccount} = useKoSubscribableChildren(userState, ['self', 'isActivatedAccount']);
  const {
    properties: {settings},
  } = propertiesRepository;
  const [optionAudio, setOptionAudio] = useState<AudioPreference>(settings.sound.alerts);
  const [optionReplaceInlineEmoji, setOptionReplaceInlineEmoji] = useState<boolean>(settings.emoji.replace_inline);
  const [optionDarkMode, setOptionDarkMode] = useState<boolean>(settings.interface.theme === ThemeViewModelThemes.DARK);
  const [optionSendPreviews, setOptionSendPreviews] = useState<boolean>(settings.previews.send);
  const [optionNotifications, setOptionNotifications] = useState<NotificationPreference>(settings.notifications);

  useEffect(() => {
    const updateProperties = ({settings}: WebappProperties): void => {
      setOptionAudio(settings.sound.alerts);
      setOptionReplaceInlineEmoji(settings.emoji.replace_inline);
      setOptionDarkMode(settings.interface.theme === ThemeViewModelThemes.DARK);
      setOptionSendPreviews(settings.previews.send);
      setOptionNotifications(settings.notifications);
    };
    const updateDarkMode = (newDarkMode: boolean) => setOptionDarkMode(newDarkMode);

    amplify.subscribe(WebAppEvents.PROPERTIES.UPDATE.INTERFACE.USE_DARK_MODE, updateDarkMode);
    amplify.subscribe(WebAppEvents.PROPERTIES.UPDATED, updateProperties);

    return () => {
      amplify.unsubscribe(WebAppEvents.PROPERTIES.UPDATE.INTERFACE.USE_DARK_MODE, updateDarkMode);
      amplify.unsubscribe(WebAppEvents.PROPERTIES.UPDATED, updateProperties);
    };
  }, []);

  const saveOptionAudioPreference = (audioPreference: AudioPreference) => {
    propertiesRepository.savePreference(PROPERTIES_TYPE.SOUND_ALERTS, audioPreference);
    setOptionAudio(audioPreference);
  };

  const saveOptionEmojiPreference = (emojiPreference: boolean) => {
    propertiesRepository.savePreference(PROPERTIES_TYPE.EMOJI.REPLACE_INLINE, emojiPreference);
    setOptionReplaceInlineEmoji(emojiPreference);
  };

  const saveOptionNotificationsPreference = (notificationsPreference: NotificationPreference) => {
    propertiesRepository.savePreference(PROPERTIES_TYPE.NOTIFICATIONS, notificationsPreference);
    setOptionNotifications(notificationsPreference);
  };

  const saveOptionSendPreviewsPreference = (sendPreviewsPreference: boolean) => {
    propertiesRepository.savePreference(PROPERTIES_TYPE.PREVIEWS.SEND, sendPreviewsPreference);
    setOptionSendPreviews(sendPreviewsPreference);
  };

  const saveOptionNewTheme = (useDarkMode: boolean) => {
    const newTheme = useDarkMode ? ThemeViewModelThemes.DARK : ThemeViewModelThemes.DEFAULT;
    propertiesRepository.savePreference(PROPERTIES_TYPE.INTERFACE.THEME, newTheme);
    setOptionDarkMode(useDarkMode);
  };

  return (
    <PreferencesPage title={t('preferencesOptions')}>
      <PreferencesSection title={t('preferencesOptionsAudio')}>
        <PreferencesRadio
          name="preferences-options-audio"
          selectedValue={optionAudio}
          onChange={saveOptionAudioPreference}
          options={[
            {
              detailLabel: t('preferencesOptionsAudioAllDetail'),
              label: t('preferencesOptionsAudioAll'),
              value: AudioPreference.ALL,
            },
            {
              detailLabel: t('preferencesOptionsAudioSomeDetail'),
              label: t('preferencesOptionsAudioSome'),
              value: AudioPreference.SOME,
            },
            {
              detailLabel: t('preferencesOptionsAudioNoneDetail'),
              label: t('preferencesOptionsAudioNone'),
              value: AudioPreference.NONE,
            },
          ]}
        />
      </PreferencesSection>

      {isActivatedAccount && (
        <>
          <hr className="preferences-separator" />

          <PreferencesSection title={t('preferencesOptionsNotifications')}>
            <PreferencesRadio
              name="preferences-options-notification"
              selectedValue={optionNotifications}
              onChange={saveOptionNotificationsPreference}
              options={[
                {
                  label: t('preferencesOptionsNotificationsOn'),
                  value: NotificationPreference.ON,
                },
                {
                  label: t('preferencesOptionsNotificationsObfuscateMessage'),
                  value: NotificationPreference.OBFUSCATE_MESSAGE,
                },
                {
                  label: t('preferencesOptionsNotificationsObfuscate'),
                  value: NotificationPreference.OBFUSCATE,
                },
                {
                  label: t('preferencesOptionsNotificationsNone'),
                  value: NotificationPreference.NONE,
                },
              ]}
            />
          </PreferencesSection>

          <hr className="preferences-separator" />

          <PreferencesSection title={t('preferencesOptionsPopular')}>
            <Checkbox
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                saveOptionNewTheme(event.target.checked);
              }}
              checked={optionDarkMode}
              data-uie-name="status-preference-use-dark-mode"
            >
              <CheckboxLabel htmlFor="status-preference-use-dark-mode">
                {t('preferencesOptionsUseDarkMode')}
              </CheckboxLabel>
            </Checkbox>

            <div className="checkbox-margin">
              <Checkbox
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                  saveOptionEmojiPreference(event.target.checked);
                }}
                checked={optionReplaceInlineEmoji}
                data-uie-name="status-preference-emoji-replace"
              >
                <CheckboxLabel htmlFor="status-preference-emoji-replace">
                  {t('preferencesOptionsEmojiReplaceCheckbox')}
                </CheckboxLabel>
              </Checkbox>

              <div
                className="preferences-detail preferences-detail-intended"
                aria-hidden="true"
                dangerouslySetInnerHTML={{
                  __html: t(
                    'preferencesOptionsEmojiReplaceDetail',
                    {},
                    {icon: "<span class='font-size-xs icon-emoji'></span>"},
                  ),
                }}
              />
            </div>

            <div className="checkbox-margin">
              <Checkbox
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                  saveOptionSendPreviewsPreference(event.target.checked);
                }}
                checked={optionSendPreviews}
                data-uie-name="status-preference-previews-send"
              >
                <CheckboxLabel htmlFor="status-preference-previews-send">
                  {t('preferencesOptionsPreviewsSendCheckbox')}
                </CheckboxLabel>
              </Checkbox>

              <div className="preferences-detail preferences-detail-intended">
                {t('preferencesOptionsPreviewsSendDetail')}
              </div>
            </div>
          </PreferencesSection>
        </>
      )}
    </PreferencesPage>
  );
};

export {OptionPreferences};
