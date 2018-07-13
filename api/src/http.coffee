# Send a HTTP request.
#
# @param {string} url - URL to send the request.
# @param {string} method - HTTP method to use (GET, POST, etc).
# @param {integer} ttl - Time in seconds for Cloudflare to cache requests.
# @param {boolean} raw - Whether to return just the raw response.
# @param {object} extra - Extra parameters passed to fetch method.
# @returns {[err, json]} - An error or JSON from a 200 status code.
request = (url, method, {ttl, raw, extra} = {}) ->
  ttl ?= 60
  extra ?= {}
  data = fetch(url, {
    method: method,
    cf: {cacheTtl: ttl} if ttl > 0,
    headers: {"Content-Type": "application/json"}
  }.merge(extra))
  if raw
    data
  else
    response = await data
    err = coerce(response.status)
    data = try JSON.parse(await response.text()) catch err then null
    [err, data]

# Redirect to another URL without loading the response.
#
# @param {string} url - URL of the request, must be an internal domain.
# @returns {promise<response>} - Promise of a request, do NOT await.
export redirect = (url) ->
  request(url = new URL(url), "GET", raw: true, extra: {cf: {resolveOverride: url.hostname}})

# Send a GET HTTP request.
#
# @see #request(url, method, ttl, extra)
export get = (url, options = {}) ->
  request(url, "GET", options)

# Send a POST HTTP request.
#
# @see #request(url, method, ttl, extra)
export post = (url, json, options = {}) ->
  request(url, "POST", {extra: {body: JSON.stringify(json)}}.merge(options))

# Respond to a HTTP request from a client.
#
# This only creates the response, the implementation
# is responsible for sending this to the client.
#
# @param {json} json - JSON payload sent back to the client.
# @param {integer} code - HTTP status code.
# @returns {response} - Encapsulated response object, not yet sent.
respond = (json, code) ->
  new Response(
    JSON.stringify(json, undefined, 2),
    {status: code, headers: {"Content-Type": "application/json", "Accept-Encoding": "gzip"}}
  )

# Respond to a HTTP request with a successful JSON response.
#
# @see #respond(json, code)
export json = (json) ->
  respond(json, 200)

# Respond to a HTTP request with an error.
#
# @see #respond(json, code)
export error = (code = 500, message = "Internal Error", reason = null) ->
  respond({status: code, message: message + (if reason then " - #{reason}" else "")}, code)

export notFound = (msg = null) ->
  error(404, "Not Found", msg)

export invalidRequest = (msg = null) ->
  error(400, "Invalid Request", msg)

export tooManyRequests = (msg = null) ->
  error(429, "Too Many Requests", msg)

# Convert an upstream HTTP status code to a new error response.
#
# @param {integer} code - HTTP status code.
# @returns {response|null} - An error response or null.
export coerce = (code) ->
  switch code
    when 200 then null
    when 204 then notFound()
    when 400 then invalidRequest()
    when 429 then tooManyRequests()
    else error()
