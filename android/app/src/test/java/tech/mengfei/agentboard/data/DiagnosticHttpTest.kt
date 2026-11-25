package tech.mengfei.agentboard.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.util.UUID
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit

class DiagnosticHttpTest {
    @Test fun postsOnlyAllowedFieldsAndNeverFollowsRedirectOrAcceptsOversizedAck() {
        ServerSocket(0, 4, InetAddress.getByName("127.0.0.1")).use { server ->
            server.soTimeout = 5000
            val base = "http://127.0.0.1:${server.localPort}"
            val target = DiagnosticTarget("private-account", "private-device", base, "private-token", true)
            val rows =
                DiagnosticEvent.entries.filterNot { it.localOnly }.mapIndexed { i, event ->
                    DiagnosticRow(
                        "private-owner",
                        UUID.randomUUID(),
                        123,
                        event,
                        DiagnosticOperation.WORKSPACE_GET.takeIf { i % 2 == 0 },
                        DiagnosticReason.NOT_FOUND.takeIf { i % 3 == 0 },
                        if (i == 0) {
                            65535
                        } else if (i == 1) {
                            2
                        } else {
                            1
                        },
                    )
                }
            val id = rows.first().id.toString()
            val ack = "{\"acked\":[\"$id\",\"$id\"]}"
            val received =
                FutureTask {
                    val requests = mutableListOf<Pair<List<String>, String>>()
                    for (n in 1..5) {
                        server.accept().use { socket ->
                            socket.soTimeout = 3000
                            val reader = socket.getInputStream().bufferedReader(Charsets.US_ASCII)
                            val headers = generateSequence(reader::readLine).takeWhile(String::isNotEmpty).toList()
                            val length =
                                headers
                                    .find { it.startsWith("Content-Length:", ignoreCase = true) }
                                    ?.substringAfter(':')
                                    ?.trim()
                                    ?.toInt() ?: 0
                            val body = buildString { repeat(length) { append(reader.read().toChar()) } }
                            requests.add(headers to body)
                            val status =
                                when (n) {
                                    2 -> "302 Found\r\nLocation: $base/other"
                                    4 -> "400 Bad Request"
                                    5 -> "503 Service Unavailable"
                                    else -> "200 OK"
                                }
                            val response =
                                when (n) {
                                    1 -> ack
                                    2 -> ""
                                    else -> " ".repeat(8192) + ack
                                }
                            socket.getOutputStream().write("HTTP/1.1 $status\r\nConnection: close\r\n\r\n$response".toByteArray())
                        }
                    }
                    requests
                }
            Thread(received).apply {
                isDaemon = true
                start()
            }
            assertEquals(setOf(id), DiagnosticHttp.post(target, rows))

            fun failure() = (runCatching { DiagnosticHttp.post(target, rows) }.exceptionOrNull() as DiagnosticHttpFailure).reason
            assertEquals(DiagnosticWaitReason.HTTP_CLIENT, failure())
            assertTrue(DiagnosticHttp.post(target, rows).isEmpty())
            assertEquals(DiagnosticWaitReason.BAD_REQUEST, failure())
            assertEquals(DiagnosticWaitReason.HTTP_SERVER, failure())
            val requests = received.get(5, TimeUnit.SECONDS)
            assertTrue(
                requests.all {
                    it.first.first() == "POST /api/device/logs HTTP/1.1" &&
                        "Authorization: Bearer private-token" in it.first
                },
            )
            val json = Json.parseToJsonElement(requests.first().second).jsonObject
            assertEquals(setOf("entries"), json.keys)
            val entries = json.getValue("entries").jsonArray
            val info =
                setOf(
                    "app_started",
                    "relay_connected",
                    "snapshot_synced",
                    "command_sent",
                    "command_executed",
                    "board_online",
                    "sync_waiting",
                    "sync_recovered",
                    "reconnecting",
                    "lookup_result",
                )
            val error =
                setOf(
                    "relay_disconnected",
                    "auth_rejected",
                    "sync_gap",
                    "command_failed",
                    "command_timeout",
                    "board_offline",
                    "board_unavailable",
                    "network_failed",
                    "protocol_invalid",
                    "pair_failed",
                    "storage_failed",
                    "attachment_failed",
                )
            assertEquals(
                info + error,
                entries
                    .map {
                        it.jsonObject
                            .getValue("event")
                            .jsonPrimitive.content
                    }.toSet(),
            )
            for ((row, jsonEntry) in rows.zip(entries)) {
                val item = jsonEntry.jsonObject
                val keys = mutableSetOf("id", "ts", "level", "event")
                if (row.operation != null) {
                    keys.add("op")
                    assertEquals("workspace_get", item.getValue("op").jsonPrimitive.content)
                }
                if (row.reason != null) {
                    keys.add("reason")
                    assertEquals("not_found", item.getValue("reason").jsonPrimitive.content)
                }
                if (row.count > 1) {
                    keys.add("count")
                    assertEquals(row.count.toString(), item.getValue("count").toString())
                }
                assertEquals(keys, item.keys)
                assertEquals(row.id.toString(), item.getValue("id").jsonPrimitive.content)
                assertEquals("123", item.getValue("ts").toString())
                assertEquals(if (row.event.name.lowercase() in info) "info" else "error", item.getValue("level").jsonPrimitive.content)
            }
        }
    }
}
