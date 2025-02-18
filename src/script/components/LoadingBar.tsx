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

import React from 'react';

import cx from 'classnames';

import {registerReactComponent} from 'Util/ComponentUtil';

export interface LoadingBarProps {
  message: string;
  progress: number;
  className?: string;
}

const LoadingBar: React.FC<LoadingBarProps> = ({progress, message, className = ''}) => (
  <div className={cx('loading-bar text-center', className)}>
    <div className="progress-console">{message}</div>
    <div className="progress-bar">
      <div data-uie-name="loading-bar-progress" style={{width: `${progress}%`}}></div>
    </div>
  </div>
);

export {LoadingBar};

registerReactComponent('loading-bar', LoadingBar);
