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
  [base, version, method, arg] = request.url.split("/")[3..6]
  if base == "mojang" && arg?
    if version == "v2"
      v2(method, arg)
    else
      notFound("Unknown API version '#{version}'")
  else
    notFound("Unknown route")

v2 = (method, arg) ->
  if method == "uuid"
    uuid(arg)
  else if method == "user"
    user(arg)
  else if method == "avatar"
    avatar(arg)
  else
    notFound("Unknown v2 route '#{method}'")
