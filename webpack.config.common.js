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

const CopyPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');
const WorkboxPlugin = require('workbox-webpack-plugin');

const path = require('path');

const {ROOT_PATH, DIST_PATH, SRC_PATH} = require('./locations');

const dist = path.resolve(DIST_PATH, 'static');
const auth = path.resolve(SRC_PATH, 'script/auth');
const srcScript = path.resolve(SRC_PATH, 'script');

module.exports = {
  cache: {
    buildDependencies: {
      // https://webpack.js.org/blog/2020-10-10-webpack-5-release/#persistent-caching
      config: [__filename],
    },
    type: 'filesystem',
  },
  devtool: 'source-map',
  entry: {
    app: path.resolve(srcScript, 'main/app.ts'),
    auth: path.resolve(auth, 'main.tsx'),
  },
  externals: {
    'fs-extra': '{}',
    worker_threads: '{}',
  },
  mode: 'production',
  module: {
    rules: [
      {
        exclude: /node_modules/,
        include: srcScript,
        loader: 'babel-loader',
        test: /\.[tj]sx?$/,
      },
      {
        loader: 'svg-inline-loader',
        options: {
          removeSVGTagAttrs: false,
        },
        test: /\.svg$/,
      },
      {
        test: /\.less$/i,
        use: [
          'style-loader',
          {
            loader: 'css-loader',
            options: {
              sourceMap: true,
              url: false,
            },
          },
          {
            loader: 'postcss-loader',
            options: {
              postcssOptions: {
                plugins: [
                  [
                    'autoprefixer',
                    {
                      browsers: ['Chrome >= 51', 'Edge >= 14', 'Firefox >= 52', 'Opera >= 40'],
                    },
                  ],
                  [require('cssnano')()],
                ],
              },
            },
          },
          {
            loader: 'less-loader',
            options: {
              sourceMap: true,
            },
          },
        ],
      },
    ],
  },
  optimization: {
    moduleIds: 'named',
    runtimeChunk: 'single',
    splitChunks: {
      cacheGroups: {
        dexie: {
          chunks: 'initial',
          enforce: true,
          name: 'dexie',
          priority: 2,
          test: /dexie/,
        },
        vendor: {
          chunks: 'initial',
          minChunks: 2,
          name: 'vendor',
          priority: 1,
          test: /node_modules/,
        },
      },
    },
  },
  output: {
    chunkFilename: 'min/[name].js',
    filename: 'min/[name].js',
    path: dist,
    publicPath: '/',
  },
  plugins: [
    new webpack.ProvidePlugin({
      $: 'jquery',
      Buffer: ['buffer', 'Buffer'],
      _: 'underscore',
      jQuery: 'jquery',
      ko: 'knockout',
    }),
    new WorkboxPlugin.InjectManifest({
      maximumFileSizeToCacheInBytes: process.env.NODE_ENV !== 'production' ? 10 * 1024 * 1024 : undefined,
      swDest: path.resolve(dist, 'sw.js'),
      swSrc: path.resolve(SRC_PATH, 'sw.js'),
    }),
    /* All wasm files will be ignored from webpack and copied over to the destination folder, they don't need any webpack processing */
    new CopyPlugin({
      patterns: [
        {
          context: 'node_modules/@wireapp/core-crypto/platforms/web/assets',
          from: '*.wasm',
          to: `${dist}/min/core-crypto.wasm`,
        },
        // copying all static resources (audio, images, fonts...)
        {from: 'resource', to: dist},
        // copying worker files
        {context: `${SRC_PATH}`, from: 'worker', to: `${dist}/worker`},
      ],
    }),
    new webpack.IgnorePlugin({resourceRegExp: /.*\.wasm/}),
  ],
  resolve: {
    alias: {
      Components: path.resolve(srcScript, 'components'),
      I18n: path.resolve(SRC_PATH, 'i18n'),
      Resource: path.resolve(ROOT_PATH, 'resource'),
      Util: path.resolve(srcScript, 'util'),
      src: path.resolve(ROOT_PATH, 'src'),
      test: path.resolve(ROOT_PATH, 'test'),
    },
    extensions: ['.js', '.jsx', '.ts', '.tsx', '.svg'],
    fallback: {
      crypto: false,
      fs: false,
      os: require.resolve('os-browserify'),
      path: require.resolve('path-browserify'),
    },
    modules: [auth, 'node_modules'],
  },
};
