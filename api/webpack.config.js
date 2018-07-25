const path = require('path')

module.exports = {
  entry: {
    bundle: path.join(__dirname, './src/index.coffee'),
  },
  output: {
    filename: 'bundle.js',
    path: path.join(__dirname, 'dist'),
  },
  mode: 'production',
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
