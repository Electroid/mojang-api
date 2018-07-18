require "net/http"
require "json"

class Mojang

  def self.user(id)
    return nil unless id
    if user = get("https://ashcon.app/minecraft/user/#{id}")
      user = JSON.parse(user)
    end
    user
  end

  def self.avatar(id, size)
    return nil unless id && size.is_a?(Integer)
    get("https://ashcon.app/minecraft/avatar/#{id}/#{size}")
  end

  private

  def self.get(url)
    response = Net::HTTP.get_response(URI(url))
    if response.is_a?(Net::HTTPSuccess)
      response.body
    elsif response.is_a?(Net::HTTPNotFound)
      nil
    else
      raise Error.new("bad http response for '#{url}' (#{response.code} - #{response.msg})")
    end
  end

  class Error < ::StandardError; end

end
