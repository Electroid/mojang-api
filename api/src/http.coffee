# Send a Http request and get a response.
#
# @param {string} url - Url to send the request.
# @param {string} method - Http method (get, post, etc).
# @param {object} body - Optional body to be sent in the request.
# @param {integer} ttl - Time in seconds for Cloudflare to cache the request.
# @param {string} key - Custom cache key for Cloudflare to index.
# @param {boolean} json - Whether to parse the response as json.
# @param {boolean} base64 - Whether to parse the response as a base64 string.
# @returns {promise<
#   json -> [err, json]
#   base64 -> string|null
#   else -> response
# >} - A different response based on the method parameters above.
export request = (url, {method, body, ttl, key, json, base64} = {}) ->
  unless url
    return Promise.resolve(undefined)
  method ?= "GET"
  ttl ?= 60
  key ?= url
  response = fetch(url,
    method: method
    body: body
    cf:
      cacheTtl: ttl
      # Pro+ only.
      polish: "lossless" if base64
      # Enterprise only.
      cacheKey: key
      cacheTtlByStatus:
        "200-299": ttl
        "300-399": -1
        "400-404": +1
        "405-599": -1
    headers:
      "User-Agent": "mojang-api (https://api.ashcon.app/mojang)"
      "Content-Type": "application/json"
      "Accept-Encoding": "gzip")
  if parse = json || base64
    response = await response
  if json
    if err = coerce(response.status)
      [err, null]
    else
      [null, await response.json()]
  else if base64
    if response.ok
      (await response.arrayBuffer()).asBase64()
  else
    response

# Send a get http request.
#
# @see #request(url)
export get = (url, options = {}) ->
  request(url, options.merge(method: "GET"))

# Send a post http request.
#
# @see #request(url)
export post = (url, body, options = {}) ->
  body = if options.json then JSON.stringify(body) else body
  request(url, options.merge(method: "POST", body: body))

# Respond to a client with a http response.
#
# @param {object} data - Data to send back in the response.
# @param {integer} code - Http status code.
# @param {string} type - Http content type.
# @param {boolean} json - Whether to respond in json.
# @param {boolean} text - Whether to respond in plain text.
# @returns {response} - Raw response object.
export respond = (data, {code, type, json, text} = {}) ->
  code ?= 200
  if json
    type = "application/json"
    data = JSON.stringify(data, undefined, 2)
  else if text
    type = "text/plain"
    data = String(data)
  else
    type ?= "application/octet-stream"
  new Response(data, {status: code, headers: {"Content-Type": type}})

# Respond with a generic http error.
#
# @see #respond(data)
export error = (reason = null, {code, type} = {}) ->
  code ?= 500
  type ?= "Internal Error"
  respond("#{code} - #{type}" + (if reason then " (#{reason})" else ""), code: code, text: true)

# Respond with a 400 - bad request error.
#
# @see #error(code, message, reason)
export badRequest = (reason = null) ->
  error(reason, code: 400, type: "Bad Request")

# Respond with a 404 - not found error.
#
# @see #error(code, message, reason)
export notFound = (reason = null) ->
  error(reason, code: 404, type: "Not Found")

# Respond with a 429 - too many requests error.
#
# @see #error(code, message, reason)
export tooManyRequests = (reason = null) ->
  error(reason, code: 429, type: "Too Many Requests")

# Convert common http error codes into error responses.
#
# @param {integer} code - Http status code.
# @returns {response|null} - An error response or null if a 200 code.
export coerce = (code) ->
  switch code
    when 200 then null
    when 204 then notFound()
    when 400 then invalidRequest()
    when 429 then tooManyRequests()
    else error("Unknown Response", code: code)
