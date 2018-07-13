os = require("os")
sharp = require("sharp")

# Safely perform mutation operations on an image buffer.
#
# @param {buffer} buf - Image buffer.
# @returns {sharp} - Cloned image buffer with the sharp module.
image = (buf) ->
  sharp(buf).clone()

# Crop out a section of an image buffer.
#
# @param {buffer} buf - Image buffer.
# @param {integer} x - Left-hand upper corner x-coordinate.
# @param {integer} y - Left-hand upper corner y-coordinate.
# @param {integer} w - Width in pixels of the crop section.
# @param {integer} h - Height in pixels of the crop section.
# @returns {promise<buffer>} - Image buffer of the cropped section.
crop = (buf, x, y, w, h) ->
  image(buf)
    .extract(left: x, top: y, width: w, height: h)
    .toBuffer()

# Place one image buffer on top of another.
#
# @param {buffer} buf0 - Image buffer at the bottom.
# @param {buffer} buf1 - Image buffer placed on top.
# @param {integer} x - Left-hand upper corner x-coordinate to place image.
# @param {integer} y - Left-hand upper corner y-coordinate to place image.
# @returns {promise<buffer>} - Image buffer with the composed image.
compose = (buf0, buf1, x = 0, y = 0) ->
  image(buf0)
    .overlayWith(buf1, left: x, top: y)
    .toBuffer()

# Resize an image to a new width and height.
#
# Uses the nearestNeighbor algorithm to keep
# pixel density without blurring.
#
# @param {buffer} buf - Image buffer to resize.
# @param {integer} size - Width and height in pixels of the new image.
# @returns {promise<[integer, buffer]>} - Image size and buffer of resized image.
resize = (buf, size) ->
  size = Math.max(0, size)
  image(buf)
    .resize(
      size * resizeCoef,
      size * resizeCoef,
      kernel: sharp.kernel.nearest
      interpolator: sharp.interpolator.nearest
      centerSampling: true)
    .png()
    .toBuffer()
    .then((buf) -> [size, buf])
resizeCoef = 2

# Resize an image to multiple new widths and heights.
#
# @see #resizeOps for the default resize options.
# @param {buffer} buf - Image buffer.
# @returns {[promise<[integer, buffer]>]} - Image buffers of resized images.
resizeMulti = (buf) ->
  Promise.all(resizeOps.map((i) ->
    resize(buf, i)))

# Return the largest default size that will encapsulate the given size.
#
# @param {integer} size - Requested size in pixels.
# @returns {integer} - Size in pixels the server allows.
resizeNearest = (size = 0) ->
  size = Math.min(size, resizeOps[-1..])
  (i for i in resizeOps when i >= size)[0]
resizeOps = [8, 16, 32, 64, 128, 256, 512]

# Reduce IO operations because of impodency.
sharp.cache(memory: os.freemem() * 1000)

# Allocate dedicated threads to process images.
sharp.concurrency(8)

# Enable special image vectoring to improve IO performance.
sharp.simd(true)
