http = require('./http')
api = require('./api')

addEventListener("fetch", (event) ->
  event.respondWith(route(event.request)))

route = (request) ->
  if match = /\/minecraft\/user\/(.*)/.exec(request.url)
    [err, uuid] = await api.uuid(match[1])
    unless err
      [err, user] = await api.user(uuid)
      unless err
        return user
  return err || http.notFound('Unknown Route')
