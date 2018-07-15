# NB: No longer saving to bucket, using Cloudflare cache.
# storage = require("@google-cloud/storage")()
# bucket = storage.bucket("#{process.env.bucket}")

# Get whether a file exists in a bucket.
#
# @param {string} name - Name of the file.
# @returns {promise<boolean>} - Whether the file exists.
exists = (name) ->
  bucket.file(name).exists().then((data) -> data[0])

# Create a read stream to access a file.
#
# @param {string} name - Name of the file.
# @returns {readablestream} - A readable stream of the file.
read = (name) ->
  bucket.file(name).createReadStream()

# Save a raw data file into a bucket.
#
# @param {string} name - Path name of the file.
# @param {object|buffer} data - Raw data file.
# @param {string} type - Type of data file (ie. application/json).
# @param {integer} ttl - Cache in seconds of the file.
save = (name, data, type, ttl) ->
  bucket.file(name).save(data,
    contentType: type
    gzip: true
    public: true
    resumable: false
    validation: false
    metadata:
      cacheControl: "public, max-age=#{ttl}")

# Save a PNG file into a bucket.
#
# @param {string} name - Path name of the file.
# @param {buffer} buf - Image buffer.
savePng = (name, buf) ->
  save(name, buf, "image/png", 604800)
