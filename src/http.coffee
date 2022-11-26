# Send a Http request and get a response.
#
# @param {string} url - Url of the request.
# @param {string} method - Http method.
# @param {string} type - Return type of the request.
# @param {object} body - Body to be sent with the request.
# @param {integer} ttl - Number of seconds to cache results.
# @param {function} parser - Function to parse the raw response.
# @returns {promise<[status, response]>} - Promise of the parsed response.
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
        cacheTtl: ttl ?= 3600
        cacheTtlByStatus:
          "200-399": ttl
          "400-599": 60
      headers:
        "Accept": type
        "User-Agent": "mojang-api/2.2 (+https://api.ashcon.app/mojang/v2)")
  response = await response
  status = response.status
  if parser
    if response.ok && response.status < 204
      response = await parser(response)
    else
      response = null
  [status, response]

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
  [status, data] = await request(url,
    ttl: ttl,
    body: body
    parser: ((response) ->
      response = await response.arrayBuffer()
      if base64
        response = response.asBase64()
      response))
  return data

# Respond to a client with a Http response.
#
# @param {object} data - Data to send back in the response.
# @param {integer} status - Http status code.
# @param {string} type - Http content type.
# @param {object} headers - Http headers.
# @param {boolean} json - Whether to respond in json.
# @param {boolean} text - Whether to respond in plain text.
# @param {boolean} svg - Whether to respond in image svg.
# @returns {response} - Raw response object.
export respond = (data, {status, type, headers, json, text, svg} = {}) ->
  status ?= 200
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
    "Content-Type": type if status != 204
  new Response(data, status: status, headers: headers)

# Respond with a Cors preflight.
#
# @see #respond(data)
export cors = ->
  headers =
    "Access-Control-Allow-Origin": "*"
    "Access-Control-Allow-Methods": "GET, OPTIONS"
    "Access-Control-Max-Age": "86400"
  respond(null, status: 204, headers: headers)

# Respond with a generic Http error.
#
# @see #respond(data)
export error = (reason = null, {status, type} = {}) ->
  status ?= 500
  type ?= new Response(null, {status: status}).statusText;
  respond({code: status, error: type, reason: reason}, status: status, json: true)

# Respond with a 400 - Bad Request error.
#
# @see #error(status, message, reason)
export badRequest = (reason = null) ->
  error(reason, status: 400, type: "Bad Request")

# Respond with a 404 - Not Found error.
#
# @see #error(status, message, reason)
export notFound = (reason = null) ->
  error(reason, status: 404, type: "Not Found")

# Respond with a 429 - Too Many Requests error.
#
# @see #error(status, message, reason)
export tooManyRequests = (reason = null) ->
  error(reason, status: 429, type: "Too Many Requests")
