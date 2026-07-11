plugins {
	alias(libs.plugins.android.application)
	alias(libs.plugins.kotlin.compose)
	alias(libs.plugins.kotlin.serialization)
}

android {
	namespace = "com.atelier_nyaarium.switchboard"
	compileSdk = 36

	signingConfigs {
		// CI supplies one stable keystore via env so every build shares a signature.
		// Without it each build's random key blocks install-over-update on a phone
		// ("App not installed"). Local builds with no env keep the default debug key
		// (debug type); a local release assembled without the env stays unsigned.
		getByName("debug") {
			val ksPath = System.getenv("ANDROID_KEYSTORE_PATH")
			if (!ksPath.isNullOrBlank()) {
				storeFile = file(ksPath)
				storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
				keyAlias = System.getenv("ANDROID_KEY_ALIAS")
				keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
			}
		}
		create("release") {
			val ksPath = System.getenv("ANDROID_KEYSTORE_PATH")
			if (!ksPath.isNullOrBlank()) {
				storeFile = file(ksPath)
				storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
				keyAlias = System.getenv("ANDROID_KEY_ALIAS")
				keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
			}
		}
	}

	defaultConfig {
		applicationId = "com.atelier_nyaarium.switchboard"
		// Android 13 (API 33) floor: the owner's device runs Android 16, this is a personal
		// console app, and 33 is the point above which the codebase carries zero version-gated
		// branches. compile/targetSdk track the latest API (36 / Android 16).
		minSdk = 33
		targetSdk = 36
		// Monotonic in CI (build number) so updates are never seen as a downgrade.
		versionCode = System.getenv("ANDROID_VERSION_CODE")?.toIntOrNull() ?: 1
		// Track the plugin version (single bump ritual covers the app too).
		versionName = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
			.find(rootProject.file("../package.json").readText())
			?.groupValues?.get(1) ?: "0.0.0"
	}

	buildTypes {
		release {
			isMinifyEnabled = true
			isShrinkResources = true
			proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
			// Sign with the stable release key only when CI provides it; a local
			// release assembled without the env stays unsigned rather than failing.
			if (!System.getenv("ANDROID_KEYSTORE_PATH").isNullOrBlank()) {
				signingConfig = signingConfigs.getByName("release")
			}
		}
		debug {
			// Minify the debug build too (the owner sideloads it): R8 tree-shakes the
			// material-icons-extended set down to only the icons actually referenced. The
			// DebugLog ingest still runs (gated on BuildConfig.DEBUG, not on minify).
			isMinifyEnabled = true
			isShrinkResources = true
			proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
		}
	}

	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_17
		targetCompatibility = JavaVersion.VERSION_17
	}

	buildFeatures {
		compose = true
		buildConfig = true
	}

	sourceSets {
		// Golden protocol fixtures live at the repo root (shared with vitest);
		// exposing them as test resources keeps the path stable across local
		// runs and CI working dirs.
		getByName("test").resources.directories.add("../../tests/fixtures")
		// Bundled assets on the test classpath so the plugin catalog agreement test can
		// enumerate assets/plugins/ and parse each baked manifest without an AssetManager.
		getByName("test").resources.directories.add("src/main/assets")
	}

}

// Name the built APKs switchboard-<variant>.apk instead of the module-default
// app-<variant>.apk, so the GitHub release assets, the sideload instructions, and the
// in-app self-updater all share the product name.
androidComponents {
	onVariants { variant ->
		variant.outputs.forEach { output ->
			(output as? com.android.build.api.variant.impl.VariantOutputImpl)
				?.outputFileName
				?.set("switchboard-${variant.name}.apk")
		}
	}
}

dependencies {
	implementation(libs.androidx.core.ktx)
	implementation(libs.androidx.lifecycle.runtime.ktx)
	implementation(libs.androidx.activity.compose)
	implementation(platform(libs.androidx.compose.bom))
	implementation(libs.androidx.ui)
	implementation(libs.androidx.ui.graphics)
	implementation(libs.androidx.ui.tooling.preview)
	implementation(libs.androidx.material3)
	implementation(libs.androidx.material.icons.extended)
	implementation(libs.okhttp)
	implementation(libs.kotlinx.coroutines.android)
	implementation(libs.androidx.security.crypto)
	implementation(libs.androidx.biometric)
	// Force a modern fragment over biometric's old transitive 1.2.x, which crashes the
	// Activity Result API (file picker) with "Can only use lower 16 bits for requestCode".
	implementation(libs.androidx.fragment)
	implementation(libs.androidx.webkit)
	implementation(libs.kotlinx.serialization.json)
	implementation(libs.bouncycastle)
	// QR enrollment scan: CameraX preview/analysis + ML Kit's bundled (GMS-free) barcode
	// model. ML Kit reads dense v40 QRs and rotationDegrees fixes the preview orientation.
	implementation(libs.androidx.camera.core)
	implementation(libs.androidx.camera.camera2)
	implementation(libs.androidx.camera.lifecycle)
	implementation(libs.androidx.camera.view)
	implementation(libs.androidx.lifecycle.runtime.compose)
	implementation(libs.mlkit.barcode.scanning)
	// QR ENCODER for the host-a-friend invite QR (the operator's phone renders a pending-tenant
	// provisioning blob the friend scans). Pure Java, GMS-free, no Android transitives.
	implementation(libs.zxing.core)

	testImplementation(libs.junit)
	// Real org.json shadowing the android.jar stub (which throws on every method) so JSON
	// serialization helpers are unit-testable off-device.
	testImplementation(libs.org.json)
}
