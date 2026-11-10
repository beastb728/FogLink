plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Road lines are shared with the simulator: copied from data/roads at build time.
val roadAssets = layout.buildDirectory.dir("roadAssets")
val syncRoads = tasks.register<Copy>("syncRoads") {
    from(rootProject.file("../data/roads")) { include("*.json") }
    into(roadAssets.map { it.dir("roads") })
}

android {
    namespace = "app.foglink"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.foglink"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        // The public relay. For a relay on the development machine use ws://10.0.2.2:8080/ws
        // from the emulator, or ws://<its LAN address>:8080/ws from a phone on the same Wi-Fi.
        // On a real phone, type the relay's address on the main screen.
        buildConfigField("String", "DEFAULT_RELAY", "\"wss://foglink-relay.fly.dev/ws\"")
    }
    buildFeatures { buildConfig = true }
    sourceSets["main"].assets.srcDir(roadAssets)
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint { abortOnError = false }
}

tasks.named("preBuild") { dependsOn(syncRoads) }

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303") // the real org.json, in place of the Android stub
}
