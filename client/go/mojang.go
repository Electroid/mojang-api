package mojang

import (
  "time"
  "io/ioutil"
  "encoding/json"
  "net/http"
)

type UserResponse struct {
  Uuid string `json:"uuid_dashed"`
  Username string `json:"username"`
  UsernameHistory []struct {
    Username string `json:"username"`
    ChangedAt time.Time `json:"changed_at"`
  } `json:"username_history"`
  Textures struct {
    Skin string `json:"skin"`
    Cape string `json:"cape"`
    Slim bool `json:"slim"`
  } `json:"textures"`
}

func User(id string) (UserResponse, error) {
  var user UserResponse
  body, err := get("https://ashcon.app/minecraft/user/" + id)
  if err != nil {
    return user, err
  }
  err = json.Unmarshal(body, &user)
  return user, err
}

func Avatar(id string, size int) ([]byte, error) {
  // TODO: Add native PNG image support
  return get("https://ashcon.app/minecraft/avatar/" + id + "/" + string(size))
}

func get(url string) ([]byte, error) {
  resp, err := http.Get(url)
  if err != nil {
    return nil, err
  }
  defer resp.Body.Close()
  return ioutil.ReadAll(resp.Body)
}
