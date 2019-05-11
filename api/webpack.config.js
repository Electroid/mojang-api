const path = require('path')

module.exports = {
  entry: {
    bundle: path.join(__dirname, './src/index.coffee'),
  },
  output: {
    filename: 'bundleV2.js',
    path: path.join(__dirname, 'dist'),
  },
  mode: 'production',
  // devtool: 'cheap-module-source-map',
  watchOptions: {
    ignored: /node_modules|dist|\.js/g,
  },
  resolve: {
    extensions: ['.coffee', '.js', '.json'],
    plugins: [],
  },
  module: {
    rules: [
      {
        test: /\.coffee?$/,
        loader: 'coffee-loader',
      }
    ]
  }
}
