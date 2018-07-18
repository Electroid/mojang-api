package app.ashcon.mojang;

import com.google.gson.annotations.SerializedName;
import com.sun.istack.internal.Nullable;

import java.net.URL;
import java.util.Date;
import java.util.List;
import java.util.Objects;
import java.util.UUID;

public class User {
    @SerializedName("uuid_dashed")
    public UUID uuid;
    @SerializedName("uuid")
    public String uuidNormalized;
    public String username;
    @SerializedName("username_history")
    public List<Username> usernameHistory;
    public Textures textures;

    public static class Username {
        public String username;
        @SerializedName("changed_at")
        public Date changedAt;
    }

    public static class Textures {
        public URL skin;
        public @Nullable URL cape;
        public boolean slim;
    }

    @Override
    public int hashCode() {
        return uuid.hashCode();
    }

    @Override
    public boolean equals(Object obj) {
        if(obj instanceof User) return Objects.equals(uuid, ((User) obj).uuid);
        return false;
    }

    @Override
    public String toString() {
        return "User{uuid=" + uuid + ",username=" + username + "}";
    }
}
