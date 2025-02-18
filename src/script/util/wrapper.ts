/*
 * Wire
 * Copyright (C) 2019 Wire Swiss GmbH
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

import {Runtime} from '@wireapp/commons';
import {WebAppEvents} from '@wireapp/webapp-events';

import {Environment} from './Environment';

import {ROLE} from '../user/UserPermission';

export function exposeWrapperGlobals(): void {
  if (Runtime.isDesktopApp()) {
    window.z ||= {};

    window.z.event ||= {};
    window.z.event.WebApp = WebAppEvents;

    window.z.util ||= {};
    window.z.util.Environment = Environment;

    window.z.team ||= {};
    window.z.team.ROLE = ROLE;
  }
}
