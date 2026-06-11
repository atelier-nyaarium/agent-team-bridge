plugins {
	alias(libs.plugins.android.application)
	alias(libs.plugins.kotlin.android)
	alias(libs.plugins.kotlin.compose)
}

android {
	namespace = "com.atelier_nyaarium.switchboard"
	compileSdk = 35

	signingConfigs {
		// CI supplies one stable keystore via env so every release shares a signature.
		// Without this each build's random debug key blocks install-over-update on a
		// phone ("App not installed"). Local builds with no env keep the default debug key.
		getByName("debug") {
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
		versionName = "0.1.0"
	}

	buildTypes {
		release {
			isMinifyEnabled = false
			proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
}
