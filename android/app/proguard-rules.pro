# OkHttp pulls in optional platform classes guarded by reflection; keep R8 quiet.
-dontwarn org.bouncycastle.jsse.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**
