package tech.mengfei.agentboard.ui

fun prefersEnglish(language: String): Boolean = language.equals("en", ignoreCase = true) || language.startsWith("en_") || language.startsWith("en-")

fun localize(english: Boolean, text: String): String {
    if (english) return text
    EXACT[text]?.let { return it }
    val code = text.substringBefore(": ", "")
    if (code.isNotEmpty() && text.startsWith("$code: ") && CODE.containsKey(code)) return CODE.getValue(code)
    return text
}

private val CODE = mapOf(
    "board_offline" to "看板不在线，中继不会排队。",
    "forbidden" to "这台手机不能访问该看板。",
    "unauthorized" to "中继拒绝了这台手机，请重新配对。",
    "rate_limited" to "请求过于频繁，请稍后再试。不会自动重试。",
    "unsupported" to "当前中继或看板还不支持这项操作。",
    "timeout" to "超时不代表失败。正在查询已保存的结果，不会再次发送命令。",
    "bad_request" to "请求无效。",
    "task_not_found" to "找不到这个任务。",
)

private val EXACT = mapOf(
    "Secure storage is unavailable, so this phone cannot keep a device token." to "安全存储不可用，这台手机不能保存设备令牌。",
    "Secure storage is unavailable, so this phone cannot store a device token." to "安全存储不可用，这台手机不能保存设备令牌。",
    "Could not store the device token. Not connecting." to "设备令牌没能写入安全存储，因此不会连接。",
    "Could not reach the relay." to "连不上中继。",
    "Enter an http or https relay URL." to "请填写 http 或 https 中继地址。",
    "relay URL is required" to "请填写中继地址。",
    "relay URL is invalid" to "中继地址无效。",
    "relay URL needs a scheme" to "中继地址需要 http 或 https。",
    "relay URL needs a host" to "中继地址需要主机名。",
    "relay HTTP URL must be http or https" to "中继地址必须是 http 或 https。",
    "relay URL must be http or https" to "中继地址必须是 http 或 https。",
    "The relay answered, but /health was not recognized." to "中继有响应，但 /health 无法识别。",
    "Relay URL saved." to "中继地址已保存。",
    "The relay rejected this device token." to "中继拒绝了这台设备的令牌。请重新配对。这和配对码过期不是一回事。",
    "Device token refreshed. Reconnecting." to "设备令牌已刷新，正在重新连接。",
    "Token refreshed but could not be stored on this phone. Reconnecting for this session." to "令牌已刷新，但这台手机没能保存。本次会话会先连上。",
    "This phone is signed out. Pair again to connect." to "这台手机已退出。要连接请重新配对。",
    "The relay rejected this phone. Pair again." to "中继拒绝了这台手机，请重新配对。",
    "The relay did not accept this phone." to "中继没有接受这台手机。",
    "Checking the stored result. This command will not be sent again." to "正在查询已保存的结果，不会再次发送命令。超时不代表失败。",
    "The next create uses a new idempotency key." to "下一次新建会使用新的幂等键。",
    "The next workspace create uses a new idempotency key." to "下一次新建工作区会使用新的幂等键。",
    "The next workspace delete uses a new idempotency key." to "下一次删除会使用新的幂等键。",
    "Not connected to the relay." to "还没有连上中继。",
    "Sending again with the same idempotency key." to "使用同一个幂等键再次发送。",
    "Reconnected. Checking the stored result. The command will not be sent again." to "已重新连接。正在查询已保存的结果，不会再次发送命令。",
    "Timed out. Checking the stored result instead of sending the command again." to "超时不代表失败。正在查询已保存的结果，不会再次发送命令。",
    "The command is still in flight. Checking again without sending it." to "命令仍在处理。会再查一次，不会重新发送。",
    "Task list is stale after a gap. Refreshing again." to "出现缺口后任务列表已过期，正在再次刷新。",
    "Relay accepted the command. Waiting for the board." to "中继已收下命令，正在等看板。",
    "Board accepted the command." to "看板已接受命令。",
    "The board did not answer in time." to "看板没有及时回复。超时不代表失败，请查询已保存的结果。",
    "The command failed after the relay stored it." to "中继已保存这条命令，但执行失败。请先查询已保存的结果。",
    "The relay has no record of this command." to "中继没有这条命令的记录。",
    "Unexpected acknowledgement." to "收到了无法识别的确认。",
    "The relay rejected the command." to "中继拒绝了这条命令。",
    "Lost the in-flight command during reconnect. It was not sent again." to "重连时丢了进行中的命令，没有再次发送。",
    "The relay reply could not be read. The command was not sent again." to "读不懂中继的回复，没有再次发送命令。",
    "Could not reach the relay to check the stored result. The command was not sent again." to "连不上中继，没能查询已保存的结果，也没有再次发送命令。",
    "The command is still in flight on the relay. It was not sent again." to "命令仍在中继上处理，没有再次发送。",
    "The command was not sent again." to "没有再次发送命令。",
    "This board cannot list archived tasks yet." to "此看板暂不支持归档浏览。需要更新后的中继和看板连接。",
    "Could not load the archive." to "归档列表没有加载成功。",
    "Could not read the archive page." to "归档这一页无法解析。",
    "Archive is not available on this relay." to "当前中继还不支持归档列表。",
    "This board is offline. The relay will not queue a command." to "看板不在线，中继不会排队。",
    "title is required, up to 200 characters" to "请填写标题，最多 200 字。",
    "prompt is required, up to 20000 characters" to "请填写提示词，最多 20000 字。",
    "cwd is required and must be a local path" to "请填写本机工作目录。",
    "name is required, up to 200 characters" to "请填写名称，最多 200 字。",
    "path is required and must be an absolute local path" to "路径必须是本机绝对路径。",
    "boardId is invalid" to "看板 ID 无效。",
    "taskId is invalid" to "任务 ID 无效。",
    "workspaceId is invalid" to "工作区 ID 无效。",
    "limit is invalid" to "分页大小无效。",
    "cursor is invalid" to "分页游标无效。",
    "idempotencyKey must be 8-80 visible ASCII characters" to "幂等键无效。",
    "boardId must be 1-64 letters, digits, '.', '_' or '-'" to "看板 ID 无效。",
)
