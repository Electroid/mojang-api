import "./util"
import { notFound } from "./http"
import { uuid, user } from "./api"

addEventListener("fetch", (event) ->
  event.respondWith(route(event.request)))

route = (request) ->
  if match = /\/minecraft\/user\/(.*)/.exec(request.url)
    [err, id] = await uuid(match[1])
    unless err
      [err, response] = await user(id)
      unless err
        return response
  return err || notFound('Unknown Route')
