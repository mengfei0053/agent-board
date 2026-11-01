plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Checked-in debug keystore (android/gradle.properties). Not a release secret.
// Local assembleDebug and CI must share this cert so sideload updates install
// in place. Never fall back to ~/.android/debug.keystore: that file is a new
// certificate on every GitHub-hosted runner and on each developer machine.
val debugKeystoreFile = rootProject.file(
    (findProperty("DEBUG_STORE_FILE") as String?)
        ?: error("Set DEBUG_STORE_FILE in android/gradle.properties")
)
val debugStorePassword = (findProperty("DEBUG_STORE_PASSWORD") as String?)
    ?: error("Set DEBUG_STORE_PASSWORD in android/gradle.properties")
val debugKeyAlias = (findProperty("DEBUG_KEY_ALIAS") as String?)
    ?: error("Set DEBUG_KEY_ALIAS in android/gradle.properties")
val debugKeyPassword = (findProperty("DEBUG_KEY_PASSWORD") as String?)
    ?: error("Set DEBUG_KEY_PASSWORD in android/gradle.properties")
check(debugKeystoreFile.isFile) {
    "Debug keystore missing at $debugKeystoreFile. " +
        "Commit android/keystore/debug.keystore and do not use ~/.android/debug.keystore."
}

android {
    namespace = "tech.mengfei.agentboard"
    compileSdk = 35

    defaultConfig {
        applicationId = "tech.mengfei.agentboard"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.2.0"
    }

    signingConfigs {
        getByName("debug") {
            storeFile = debugKeystoreFile
            storePassword = debugStorePassword
            keyAlias = debugKeyAlias
            keyPassword = debugKeyPassword
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("debug")
        }
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(project(":protocol"))
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.security:security-crypto:1.0.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
