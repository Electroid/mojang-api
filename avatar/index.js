const os = require('os')
const request = require('request-promise-native')
const sharp = require('sharp')
  sharp.cache({memory: os.freemem() * 1000})
  sharp.concurrency(4)
const textureUrl = 'http://textures.minecraft.net/texture/'
const textureDefault = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAACXBIWXMAAAsSAAALEgHS3X78AAAA+ElEQVQYlSXPv0rDQADA4V/uLn/UpnaQBlwaEVydXBzFSZ/AqYKL4CM46Kbo1kGhi+Cim4MdOhbpJDi4iUgrKFWHEImRkuYucfB7g08th36pC1CWIDMarQ1CCGwlKUtQugAAXRbMeA6zjoVBEqUZpjQogNO9Jq7tMOVVGf8mIAXx54jjmy7qoLlFkVtEaYqUOXES0wjqfP8k7K6vIqZdl839Fte9Rbx8QiOoc94J2Dm7pTo3j1xbqB2O7nusLBk6d32eXoZsb9ToX7V4fh0g0tzw9j7g5KJNWPEJKz5H7UuidIyFjRp+fFEU/5Xu4wPSVgCkY0OWT/gDhGpgBACeSmEAAAAASUVORK5CYII=', 'base64')

/**
 * Extract and render the face and hat of a user given
 * access to their full texture URL.
 *
 * If any data is invalid, #fallback(res, size) will be
 * called and gaureentees a "steve" response.
 *
 * @param {request} req - HTTP request sent to the server.
 * @param {response} res - HTTP response sent back to the client.
 */
exports.avatar = (req, res) => {
  var texture = req.body.texture
  var size = req.body.size
  if(typeof texture === 'string' && typeof size === 'number') {
    // Limit range of image size to prevent bad requests
    size = Math.max(Math.min(Math.ceil(size), 512), 8)
    request({uri: textureUrl + texture, encoding: null})
      .then(body => sharp(body)
        // Extract the hat and wait for its buffer
        .extract({left: 40, top: 8, width: 8, height: 8})
        .toBuffer()
        .then(hat => sharp(body)
          // Extract the face and overlay the hat on top of it
          .extract({left: 8, top: 8, width: 8, height: 8})
          .overlayWith(hat, {left: 0, top: 0})
          // Resize the image while keeping pixel ratio
          .resize(size, size, {
            kernel: sharp.kernel.nearest,
            interpolator: sharp.interpolator.nearest,
            centerSampling: true
          })
          .png()
          .toBuffer()))
      .then(face => reply(res, face))
      .catch(err => {
        console.error(err)
        fallback(res, size)
      })
  } else {
    fallback(res, 8)
  }
}

/**
 * Render a fallback "steve" face to the requested size.
 *
 * If resizing fails, render the standard 8x8 pixel size,
 * instead of rendering nothing.
 *
 * @param {response} res - HTTP response sent back to the client.
 * @param {integer} size - The size in pixels for the "steve" to be rendered.
 */
fallback = (res, size) => {
  sharp(textureDefault)
    .resize(size, size, {
      kernel: sharp.kernel.nearest,
      interpolator: sharp.interpolator.nearest,
      centerSampling: true
    })
    .toBuffer()
    .then(fallback => reply(res, fallback, 404)) // Resized steve
    .catch(err => reply(res, textureDefault, 500)) // Non-resized steve
}

/**
 * Reply to the client with a PNG buffer and status code.
 *
 * @param {response} res - HTTP response sent back to the client.
 * @param {buffer} png - PNG raw buffer.
 * @param {integer} code - HTTP status code to send with the PNG.
 */
reply = (res, png, code = 200) => {
  res.set('Content-Type', 'image/png')
  res.status(code).send(png)
}
