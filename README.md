# mojang-api
Javascript microservice that bundles multiple Mojang APIs into a single GET request.

### Purpose

Mojang provides multiple APIs for Minecraft servers to fetch identity information about users. Requests do not accept authentication tokens, however they are heavily rate limited and fragmented amongst several endpoints. The purpose of this microservice is to package the three most commonly used APIs into a single GET request with automatic caching and (almost) no rate limiting.

I have deployed this on my personal domain `ashcon.app` and am opening it up for the internet to use for free. It runs using Cloudflare Workers, which are Javascript functions that live in the closest datacenter to your request. Caching is automatically handled by the service, so there is no need for complex HTTP clients with backoff policies.

#### Single GET *(new)*

1. Username | UUID -> Everything<br>
   [https://ashcon.app/minecraft/user/[username|uuid]](https://ashcon.app/minecraft/user/Notch)
  ```
  {
    "uuid": <uuid>,
    "uuid_dashed": <uuid>,
    "username": <username>,
    "username_history": [
      {
        "username": <username>,
        "changed_at": <date|null>
      }
    ],
    "textures": {
      "skin": <url>,
      "cape": <url|null>,
      "slim": <boolean>
    },
    "cached_at": <date>
  }
  ```

#### Multiple GETs *(old)*

1. Username -> UUID<br>
   [https://api.mojang.com/users/profile/minecraft/[username]](https://api.mojang.com/users/profile/minecraft/Notch)
  ```
  {
    "id": <uuid>,
    "name": <username>
  }
  ```
2. UUID -> Username History<br>
  [https://api.mojang.com/user/profiles/[uuid]/names](https://api.mojang.com/user/profiles/069a79f444e94726a5befca90e38aaf5/names)
  ```
  [
    {
      "name": <username>
    },
    {
      "name": <username>,
      "changedToAt": <integer>
    }
  ]
  ```
3. UUID -> Profile + Textures<br>
  [https://sessionserver.mojang.com/session/minecraft/profile/[uuid]](https://sessionserver.mojang.com/session/minecraft/profile/069a79f444e94726a5befca90e38aaf5)
  ```
  {
    "id": <uuid>,
    "name": <username>,
    "properties": [
      {
        "name": "textures",
        "value": <base64> // Then decode the base64 string...
      }
    ]
  }
  ```
