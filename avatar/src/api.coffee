request = require("request-promise-cache")

# Fetch the user profile from a UUID or username.
#
# @param {string} id - UUID or username.
# @returns {promise<json>} - User profile as JSON.
profile = (id) ->
  request(uri: "https://api.ashcon.app/minecraft/user/#{id}", json: true, transform2xxOnly: true, cacheTTL: 300)

# Fetch and download binary data as a buffer.
#
# @param {string} url - URL of the binary file to fetch.
# @returns {promise<buffer>} - Binary file as a buffer.
binary = (url) ->
  request(uri: url, encoding: null, transform2xxOnly: true, cacheTTL: 300)
    # BUG: Cached requests do not return Buffer, but an object containing it
    .then((buf) -> if Buffer.isBuffer(buf) then buf else Buffer.from(buf.data))
