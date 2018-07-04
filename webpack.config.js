const path = require('path')
const webpack = require('webpack')
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin

module.exports = {
  entry: {
    bundle: path.join(__dirname, './src/index.coffee'),
  },
  output: {
    filename: 'bundle.js',
    path: path.join(__dirname, 'dist'),
  },
  mode: 'development',
  watchOptions: {
    ignored: /node_modules|dist|\.js/g,
  },
  devtool: 'cheap-module-eval-source-map',
  resolve: {
    extensions: ['.coffee', '.js', '.json'],
    plugins: [],
  },
  module: {
    rules: [
      {
        test: /\.coffee?$/,
        loader: 'coffee-loader',
      },
    ],
  },
  node: {
    fs: 'empty'
  },
  //optimization: {
  //  minimize: true
  //},
  plugins: [
    //new BundleAnalyzerPlugin(),
    //new webpack.IgnorePlugin(/ml-.*|pako/)
  ]
}
