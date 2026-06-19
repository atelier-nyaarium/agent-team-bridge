# OkHttp's optional TLS-provider -dontwarn lines (org.bouncycastle.jsse / org.conscrypt /
# org.openjsse) were removed after confirming assembleRelease stays clean without them: the
# okhttp artifact ships its own consumer -dontwarn rules for these packages, so the app-level
# copies were redundant. Re-add if an assembleRelease ever fails with a missing-class error for
# one of those packages.

# kotlinx.serialization (the console/gateway wire protocol) needs NO app-level keeps: the
# artifact ships COMPLETE R8 consumer rules (META-INF/com.android.tools/r8/) that AGP
# auto-applies and that cover the sealed-polymorphic ConsoleOp/EnrollOp dispatch. Confirmed by
# the on-device minified wire round-trip (register/poll/seal); no manual block is required.

# BouncyCastle is used via its LOW-LEVEL API by direct class reference (no JCE provider /
# reflection - see Crypto.kt), so R8 reachability keeps exactly the referenced classes and
# safely tree-shakes the rest. No broad -keep is needed.

# WebView JS bridge: ThreadRenderer exposes @JavascriptInterface methods that thread.js calls
# BY NAME (Android.playMessage / retryMessage / openAttachment). R8 must not rename/strip them
# or the thread WebView bridge breaks silently (and the break never shows in the console-ingest
# trace). LOAD-BEARING, not placebo: the AGP default only keeps @JavascriptInterface on WebView
# SUBCLASSES, but this bridge is an anonymous object on a class that merely holds a WebView, so
# the default misses it. This is the one required app-level keep.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
