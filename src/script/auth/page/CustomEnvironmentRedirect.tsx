/*
 * Wire
 * Copyright (C) 2020 Wire Swiss GmbH
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

import {useEffect, useState} from 'react';

import {Runtime, UrlUtil} from '@wireapp/commons';
import {COLOR, ContainerXS, FlexBox, Text} from '@wireapp/react-ui-kit';
import {SVGIcon} from '@wireapp/react-ui-kit/lib/Icon/SVGIcon';
import {useIntl} from 'react-intl';
import {connect} from 'react-redux';
import {AnyAction, Dispatch} from 'redux';

import {afterRender} from 'Util/util';

import {Page} from './Page';

import {customEnvRedirectStrings} from '../../strings';
import {actionRoot} from '../module/action';
import {bindActionCreators} from '../module/reducer';
import {QUERY_KEY} from '../route';
import {getSVG} from '../util/SVGProvider';

const REDIRECT_DELAY = 5000;
const CustomEnvironmentRedirectComponent = ({doNavigate, doSendNavigationEvent}: DispatchProps) => {
  const {formatMessage: _} = useIntl();

  const [destinationUrl, setDestinationUrl] = useState<string | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    const destinationParam = UrlUtil.getURLParameter(QUERY_KEY.DESTINATION_URL);
    setDestinationUrl(destinationParam);
  }, []);

  useEffect(() => {
    let redirectTimeoutId: number;
    if (destinationUrl) {
      redirectTimeoutId = window.setTimeout(() => {
        if (Runtime.isDesktopApp()) {
          doSendNavigationEvent(destinationUrl).catch(console.error);
        } else {
          doNavigate(destinationUrl);
        }
      }, REDIRECT_DELAY);
      afterRender(() => setIsAnimating(true));
    }
    return () => {
      window.clearTimeout(redirectTimeoutId);
    };
  }, [destinationUrl]);

  return (
    <Page>
      <FlexBox column>
        <FlexBox
          justify="center"
          align="flex-end"
          style={{backgroundColor: 'black', height: 216, marginBottom: 64, width: '100vw'}}
        >
          <FlexBox
            justify="center"
            align="center"
            style={{
              backgroundColor: COLOR.ICON,
              borderRadius: '50%',
              boxShadow: '0 2px 4px 0 rgba(53, 63, 71, 0.29)',
              height: 120,
              marginBottom: -64,
              position: 'relative',
              width: 120,
            }}
          >
            <SVGIcon aria-hidden="true" color={COLOR.WHITE} realWidth={47} realHeight={38}>
              <g dangerouslySetInnerHTML={{__html: getSVG('logo-icon')?.documentElement?.innerHTML}} />
            </SVGIcon>
            <svg
              aria-hidden="true"
              style={{position: 'absolute'}}
              width={124}
              height={124}
              viewBox="0 0 124 124"
              fill="none"
              data-uie-name="redirection-timer"
            >
              <circle
                style={{
                  strokeDashoffset: isAnimating ? 0 : 377,
                  transition: `stroke-dashoffset ${REDIRECT_DELAY}ms linear`,
                }}
                cx="62"
                cy="62"
                r="60"
                strokeWidth="4"
                stroke={COLOR.BLUE}
                strokeLinecap="round"
                strokeDasharray={377}
                transform="rotate(-90)"
                // eslint-disable-next-line react/no-unknown-property
                transform-origin="center"
              />
            </svg>
          </FlexBox>
        </FlexBox>
        <ContainerXS centerText style={{marginTop: 48}}>
          <Text block bold fontSize={'24px'} center style={{marginBottom: 16, marginTop: 0}}>
            {_(customEnvRedirectStrings.redirectHeadline)}
          </Text>
          <Text block center>
            {_(customEnvRedirectStrings.redirectTo)}
          </Text>
          <Text block center fontSize="16px" bold style={{marginTop: '16px'}} data-uie-name="credentials-info">
            {_(customEnvRedirectStrings.credentialsInfo)}
          </Text>
        </ContainerXS>
      </FlexBox>
    </Page>
  );
};

type DispatchProps = ReturnType<typeof mapDispatchToProps>;
const mapDispatchToProps = (dispatch: Dispatch<AnyAction>) =>
  bindActionCreators(
    {
      doNavigate: actionRoot.navigationAction.doNavigate,
      doSendNavigationEvent: actionRoot.wrapperEventAction.doSendNavigationEvent,
    },
    dispatch,
  );

const CustomEnvironmentRedirect = connect(null, mapDispatchToProps)(CustomEnvironmentRedirectComponent);

export {CustomEnvironmentRedirect};
