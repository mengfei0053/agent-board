import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    `java-library`
    kotlin("jvm")
    kotlin("plugin.serialization")
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

tasks.withType<JavaCompile>().configureEach {
    sourceCompatibility = JavaVersion.VERSION_17.toString()
    targetCompatibility = JavaVersion.VERSION_17.toString()
}

dependencies {
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    testImplementation(kotlin("test-junit"))
}
