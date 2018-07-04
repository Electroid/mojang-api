fetch = require("node-fetch")
fs = require("fs")

# Send a HTTP request and cache the response to a local file.
#
# @param {string} url - URL of the HTTP request.
# @param {object} options - Extra options for #fetch().
cache = (url, options = {}) ->
  now = Math.floor(new Date() / 1000)
  unless entry = cacheObject[url] && entry.time <= now
    response = await fetch(url, options)
    entry = cacheObject[url] =
      time: now + (options?.cf?.cacheTtl ? 0)
      value: # Only these fields need to be serialized.
        status: response.status
        text: text = await response.text()
        json: try JSON.parse(text) catch err then null
  entry.value
cacheFile = "./test/cache.json"
cacheObject = JSON.parse(fs.readFileSync(cacheFile, "utf8"))

# Save the responses in-memory to a local file.
flush = ->
  fs.writeFileSync(cacheFile, JSON.stringify(cacheObject))
process.on("exit", () -> flush())

module.exports = cache
