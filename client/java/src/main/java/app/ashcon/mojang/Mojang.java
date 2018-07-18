package app.ashcon.mojang;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.UnsupportedEncodingException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Optional;

public class Mojang {

    public static Optional<User> user(String id) {
        return get("https://ashcon.app/minecraft/user/" + id).map(in -> {
            try {
                return gson.fromJson(new InputStreamReader(in, "UTF-8"), User.class);
            } catch(UnsupportedEncodingException uee) {
                throw new Exception(uee);
            }
        });
    }

    public static Optional<BufferedImage> avatar(String id, int size) {
        return get("https://ashcon.app/minecraft/avatar/" + id + "/" + size).map(in -> {
            try {
                return ImageIO.read(in);
            } catch(IOException ioe) {
                throw new Exception(ioe);
            }
        });
    }

    private static Optional<InputStream> get(String url) {
        try {
            HttpURLConnection http = (HttpURLConnection) new URL(url).openConnection();
            http.setRequestMethod("GET");
            http.setRequestProperty("User-Agent", "mojang-api-java");
            http.connect();
            int code = http.getResponseCode();
            String msg = http.getResponseMessage();
            switch(code) {
                case 200:
                    return Optional.of(http.getInputStream());
                case 404:
                    return Optional.empty();
                default:
                    throw new Exception("bad http response for '" + url + "' (" + code + " - " + msg + ")");
            }
        } catch(IOException ioe) {
            throw new Exception(ioe);
        }
    }

    public static class Exception extends RuntimeException {
        private Exception(String message) {
            super(message);
        }
        private Exception(java.lang.Exception cause) {
            super(cause);
        }
    }

    private static final Gson gson = new GsonBuilder().setPrettyPrinting().create();

}
