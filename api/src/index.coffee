import "./util"
import { error, notFound } from "./http"
import { uuid, user, avatar } from "./api"

addEventListener("fetch", (event) ->
  event.respondWith(route(event.request)))

routeDebug = (request) ->
  try
    await route(request)
  catch err
    error(err.stack || err)

route = (request) ->
  [base, version, method, arg, extra] = request.url.split("/")[3..7]
  if base == "mojang" && arg?
    if version == "v2"
      v2(method, arg, extra)
    else
      notFound("Unknown API version '#{version}'")
  else
    notFound("Unknown route")

v2 = (method, arg, extra) ->
  if method == "uuid"
    uuid(arg)
  else if method == "user"
    user(arg)
  else if method == "avatar"
    avatar(arg, extra)
  else
    notFound("Unknown v2 route '#{method}'")
