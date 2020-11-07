const path = require('path')

module.exports = {
  entry: {
    bundle: path.join(__dirname, './src/index.coffee'),
  },
  output: {
    filename: 'worker.js',
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
  },
  plugins: [
    function() { // Certain build errors give no stack trace by default
      this.plugin("done", function(stats) {
        if (stats.compilation.errors && stats.compilation.errors.length) {
            console.error(stats.compilation.errors)
            process.exit(1)
          }
      })
    }
  ]
}
