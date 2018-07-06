# An efficient method of converting
# base 16 representations into base 10.
#
# Much faster than #parseInt(hex, 16).
# @param {integer} i - Index of the string.
# @returns {integer} - Base 10 representation of the string.
String::toInt = (i = 0) ->
  c = this.charCodeAt(i)
  if c >= 97 # a-f
    c - 87
  else # 0-9
    c - 48

# Merge two hashes together into one.
#
# If a key exists in both hashes, only the value
# from the second hash will exist since it is applied last.
#
# @param {object} other - The second hash, applied to this.
Object::merge = (other) ->
  Object.assign({}, this, other)

# Ensure that the string is an non-dashed UUID.
#
# @param {boolean} dashed - Whether to return a dashed UUID.
# @returns {boolean|string} - False or a UUID.
String::asUuid = ({dashed} = {}) ->
  dashed ?= false
  if match = uuidPattern.exec(this)
    uuid = match[1..].join('')
    if dashed
      [uuid.substring(0, 8)
       uuid.substring(8, 12)
       uuid.substring(12, 16)
       uuid.substring(16, 20)
       uuid.substring(20, 32)
      ].join('-')
    else
      uuid
uuidPattern = /^([0-9a-f]{8})(?:-|)([0-9a-f]{4})(?:-|)(4[0-9a-f]{3})(?:-|)([0-9a-f]{4})(?:-|)([0-9a-f]{12})$/i

# Ensure that the string is a valid Minecraft username.
#
# @returns {boolean|string} - False or the Minecraft username.
String::asUsername = ->
  if usernamePattern.test(this) then this else false
usernamePattern = /^[0-9A-Za-z_]{1,16}$/i

# Ensure that the string is a valid JSON schema.
#
# @returns {boolean|string} - False or a JSON object.
String::asJson = ->
  try
    JSON.parse(this)
  catch
    false

# Ensure that the unix number is a Date.
#
# @returns {date} - The number as a floored Date.
Number::asDate = ->
  new Date(Math.floor(this))

# Determine if the object is empty.
#
# @returns {boolean} - Whether the object is empty.
Object::isEmpty = ->
  Object.keys(this).length == 0
