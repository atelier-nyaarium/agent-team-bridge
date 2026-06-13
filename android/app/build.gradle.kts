plugins {
	alias(libs.plugins.android.application)
	alias(libs.plugins.kotlin.android)
	alias(libs.plugins.kotlin.compose)
	alias(libs.plugins.kotlin.serialization)
}

android {
	namespace = "com.atelier_nyaarium.switchboard"
	compileSdk = 35

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
		minSdk = 26
		targetSdk = 35
		// Monotonic in CI (build number) so updates are never seen as a downgrade.
		versionCode = System.getenv("ANDROID_VERSION_CODE")?.toIntOrNull() ?: 1
		// Track the plugin version (single bump ritual covers the app too).
		versionName = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
			.find(rootProject.file("../package.json").readText())
			?.groupValues?.get(1) ?: "0.0.0"
	}

	buildTypes {
		release {
			isMinifyEnabled = false
			proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
			// Sign with the stable release key only when CI provides it; a local
			// release assembled without the env stays unsigned rather than failing.
			if (!System.getenv("ANDROID_KEYSTORE_PATH").isNullOrBlank()) {
				signingConfig = signingConfigs.getByName("release")
			}
		}
	}

	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_17
		targetCompatibility = JavaVersion.VERSION_17
	}

	kotlinOptions {
		jvmTarget = "17"
	}

	buildFeatures {
		compose = true
		buildConfig = true
	}

	sourceSets {
		// Golden protocol fixtures live at the repo root (shared with vitest);
		// exposing them as test resources keeps the path stable across local
		// runs and CI working dirs.
		getByName("test").resources.srcDir("../../tests/fixtures")
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
	implementation(libs.okhttp)
	implementation(libs.kotlinx.coroutines.android)
	implementation(libs.androidx.security.crypto)
	implementation(libs.androidx.biometric)
	// Force a modern fragment over biometric's old transitive 1.2.x, which crashes the
	// Activity Result API (file picker) with "Can only use lower 16 bits for requestCode".
	implementation(libs.androidx.fragment)
	implementation(libs.androidx.webkit)
	implementation(libs.kotlinx.serialization.json)

	testImplementation(libs.junit)
}
