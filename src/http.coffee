# Send a Http request and get a response.
#
# @param {string} url - Url of the request.
# @param {string} method - Http method.
# @param {string} type - Return type of the request.
# @param {object} body - Body to be sent with the request.
# @param {integer} ttl - Number of seconds to cache results.
# @param {function} parser - Function to parse the raw response.
# @returns {promise<response>} - Promise of the parsed response.
export request = (url, {method, type, body, ttl, parser} = {}) ->
  method ?= "POST" if body
  method ?= "GET"
  if url instanceof Promise
    response = url
  else
    response = fetch(url,
      method: method
      body: body
      cf:
        mirage: true
        polish: "lossy"
        cacheEverything: true
        cacheTtl: ttl ?= 300
        cacheTtlByStatus:
          "200-299": ttl
          "300-399": 120
          "400-499": 60
          "500-599": 5
      headers:
        "Accept": type
        "User-Agent": "mojang-api/2.2 (+https://api.ashcon.app/mojang/v2)")
  if parser
    response = await response
    if response.ok && response.status < 204
      response = await parser(response)
    else
      response = null
  response

# Send a Http request and get a Json response.
#
# @param {string} url - Url of the request.
# @param {object} body - Json body to be sent with the request.
# @param {integer} ttl - Number of seconds to cache results.
# @returns {promise<object>} - Promise of a Json response.
export json = (url, {body, ttl} = {}) ->
  request(url,
    ttl: ttl,
    type: "application/json"
    body: JSON.stringify(body) if body
    parser: ((response) -> await response.json()))

# Send a Http request and get a Buffer response.
#
# @param {string} url - Url of the request.
# @param {object} body - Body to be sent with the request.
# @param {integer} ttl - Number of seconds to cache results.
# @param {boolean} base64 - Whether to encode the response as base64.
# @returns {promise<object>} - Promise of a Buffer response.
export buffer = (url, {body, ttl, base64} = {}) ->
  base64 ?= true
  request(url,
    ttl: ttl,
    body: body
    parser: ((response) ->
      response = await response.arrayBuffer()
      if base64
        response = response.asBase64()
      response))

# Respond to a client with a Http response.
#
# @param {object} data - Data to send back in the response.
# @param {integer} code - Http status code.
# @param {string} type - Http content type.
# @param {object} headers - Http headers.
# @param {boolean} json - Whether to respond in json.
# @param {boolean} text - Whether to respond in plain text.
# @param {boolean} svg - Whether to respond in image svg.
# @returns {response} - Raw response object.
export respond = (data, {code, type, headers, json, text, svg} = {}) ->
  code ?= 200
  if json
    type = "application/json"
    data = JSON.stringify(data, undefined, 2)
  else if text
    type = "text/plain"
    data = String(data)
  else if svg
    type = "image/svg+xml"
    data = String(data)
  else
    type ?= "application/octet-stream"
  headers ?=
    "Access-Control-Allow-Origin": "*"
    "Content-Type": type if code != 204
  new Response(data, status: code, headers: headers)

# Respond with a Cors preflight.
#
# @see #respond(data)
export cors = ->
  headers =
    "Access-Control-Allow-Origin": "*"
    "Access-Control-Allow-Methods": "GET, OPTIONS"
    "Access-Control-Max-Age": "86400"
  respond(null, code: 204, headers: headers)

# Respond with a generic Http error.
#
# @see #respond(data)
export error = (reason = null, {code, type} = {}) ->
  code ?= 500
  type ?= "Internal Error"
  respond({code: code, error: type, reason: reason}, code: code, json: true)

# Respond with a 400 - Bad Request error.
#
# @see #error(code, message, reason)
export badRequest = (reason = null) ->
  error(reason, code: 400, type: "Bad Request")

# Respond with a 404 - Not Found error.
#
# @see #error(code, message, reason)
export notFound = (reason = null) ->
  error(reason, code: 404, type: "Not Found")

# Respond with a 429 - Too Many Requests error.
#
# @see #error(code, message, reason)
export tooManyRequests = (reason = null) ->
  error(reason, code: 429, type: "Too Many Requests")
