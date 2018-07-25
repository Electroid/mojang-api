# Convert base 16 representations into base 10,
# much faster than #parseInt(hex, 16).
#
# @param {integer} i - Index of the string.
# @returns {integer} - Base 10 representation of the string.
String::toInt = (i = 0) ->
  c = this.charCodeAt(i)
  if c >= 97 # a-f
    c - 87
  else # 0-9
    c - 48

# Merge two objects together into one.
#
# If a key exists in both objects, only the value
# from the second object will exist since it is applied last.
#
# @param {object} other - Object to merge into the original.
Object::merge = (other) ->
  Object.assign({}, this, other)

# Insert a string at a given index.
#
# @param {integer} i - Index to insert the string at.
# @param {string} str - String to insert.
String::insert = (i, str) ->
  this.slice(0, i) + str + this.slice(i)

# Ensure that the string is a valid Uuid.
#
# If dashed is enabled, it is possible the input
# string is not the same as the output string.
#
# @param {boolean} dashed - Whether to return a dashed uuid.
# @returns {string|null} - A uuid or null.
String::asUuid = ({dashed} = {}) ->
  if match = uuidPattern.exec(this)
    uuid = match[1..].join("")
    if dashed
      uuid.insert(8, "-")
          .insert(12+1, "-")
          .insert(16+2, "-")
          .insert(20+3, "-")
    else
      uuid
uuidPattern = /^([0-9a-f]{8})(?:-|)([0-9a-f]{4})(?:-|)(4[0-9a-f]{3})(?:-|)([0-9a-f]{4})(?:-|)([0-9a-f]{12})$/i

# Ensure that the string is a valid Minecraft username.
#
# @returns {string|null} - Minecraft username or null.
String::asUsername = ->
  if usernamePattern.test(this) then this else false
usernamePattern = /^[0-9A-Za-z_]{1,16}$/i

# Ensure that the unix number is a Date.
#
# @returns {date} - The number as a floored date.
Number::asDate = ->
  new Date(Math.floor(this))

# Determine if the object is empty.
#
# @returns {boolean} - Whether the object is empty.
Object::isEmpty = ->
  Object.keys(this).length == 0

# Fast method of encoding an array buffer as a base64 string.
#
# @copyright https://gist.github.com/jonleighton/958841
# @returns {string} - Array buffer as base64 string.
ArrayBuffer::asBase64 = ->
  base64 = ""
  encodings = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  bytes = new Uint8Array(this)
  byteLength = bytes.byteLength
  byteRemainder = byteLength % 3
  mainLength = byteLength - byteRemainder
  i = 0
  # Main loop deals with bytes in chunks of 3
  while i < mainLength
    # Combine the three bytes into a single integer
    chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    # Use bitmasks to extract 6-bit segments from the triplet
    a = (chunk & 16515072) >> 18 # 16515072 = (2^6 - 1) << 18
    b = (chunk & 258048)   >> 12 # 258048   = (2^6 - 1) << 12
    c = (chunk & 4032)     >>  6 # 4032     = (2^6 - 1) << 6
    d = chunk & 63               # 63       = 2^6 - 1
    # Convert the raw binary segments to the appropriate ASCII encoding
    base64 += encodings[a] + encodings[b] + encodings[c] + encodings[d]
    i = i + 3
  # Deal with the remaining bytes and padding
  if (byteRemainder == 1)
    chunk = bytes[mainLength]
    a = (chunk & 252) >> 2 # 252 = (2^6 - 1) << 2
    # Set the 4 least significant bits to zero
    b = (chunk & 3)   << 4 # 3   = 2^2 - 1
    base64 += encodings[a] + encodings[b] + "=="
  else if (byteRemainder == 2)
    chunk = (bytes[mainLength] << 8) | bytes[mainLength + 1]
    a = (chunk & 64512) >> 10 # 64512 = (2^6 - 1) << 10
    b = (chunk & 1008)  >>  4 # 1008  = (2^6 - 1) << 4
    # Set the 2 least significant bits to zero
    c = (chunk & 15)    <<  2 # 15    = 2^4 - 1
    base64 += encodings[a] + encodings[b] + encodings[c] + "="
  base64
