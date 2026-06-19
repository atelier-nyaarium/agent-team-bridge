# OkHttp pulls in optional platform classes guarded by reflection; keep R8 quiet.
-dontwarn org.bouncycastle.jsse.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**

# kotlinx.serialization is the console/gateway wire protocol. The artifact already ships
# COMPLETE R8 consumer rules (META-INF/com.android.tools/r8/) that AGP auto-applies and that
# cover the sealed-polymorphic ConsoleOp/EnrollOp dispatch - those are the load-bearing source.
# The block below is redundant belt-and-suspenders for the first minified ship; once the
# on-device wire round-trip confirms the build, strip it and re-verify (expected safe to drop).
-keepattributes RuntimeVisibleAnnotations,AnnotationDefault
-if @kotlinx.serialization.Serializable class **
-keepclassmembers class <1> {
    static <1>$Companion Companion;
}
-if @kotlinx.serialization.Serializable class ** {
    static **$Companion Companion;
}
-keepclassmembers class <1>$Companion {
    kotlinx.serialization.KSerializer serializer(...);
}
-if @kotlinx.serialization.Serializable class ** {
    public static ** INSTANCE;
}
-keepclassmembers class <1> {
    public static <1> INSTANCE;
    kotlinx.serialization.KSerializer serializer(...);
}

# BouncyCastle is used via its LOW-LEVEL API by direct class reference (no JCE provider /
# reflection - see Crypto.kt), so R8 reachability keeps exactly the referenced classes and
# safely tree-shakes the rest. No broad -keep is needed.

# WebView JS bridge: ThreadRenderer exposes @JavascriptInterface methods that thread.js calls
# BY NAME (Android.playMessage / retryMessage / openAttachment). R8 must not rename/strip them
# or the thread WebView bridge breaks silently (and the break never shows in the console-ingest
# trace). LOAD-BEARING, not placebo: the AGP default only keeps @JavascriptInterface on WebView
# SUBCLASSES, but this bridge is an anonymous object on a class that merely holds a WebView, so
# the default misses it. Do NOT delete this when pruning the serialization block above.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
