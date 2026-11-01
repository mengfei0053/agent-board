package tech.mengfei.agentboard.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import tech.mengfei.agentboard.protocol.statusLabel

internal enum class BoardIcon(val paths: List<String>) {
    Boards(listOf("M4.5 4h4A1.5 1.5 0 0 1 10 5.5v4A1.5 1.5 0 0 1 8.5 11h-4A1.5 1.5 0 0 1 3 9.5v-4A1.5 1.5 0 0 1 4.5 4Z", "M15.5 4h4A1.5 1.5 0 0 1 21 5.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-4A1.5 1.5 0 0 1 15.5 4Z", "M4.5 13h4a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 8.5 20h-4A1.5 1.5 0 0 1 3 18.5v-4A1.5 1.5 0 0 1 4.5 13Z", "M15.5 13h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5v-4a1.5 1.5 0 0 1 1.5-1.5Z")),
    Workspace(listOf("M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z", "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.2.6.7 1.1 1.5 1.1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z")),
    Settings(listOf("M4 6h16M4 12h10M4 18h10", "M18 9.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4Z", "M16 15.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4Z")),
    Chevron(listOf("M6 9l6 6 6-6")),
    Back(listOf("M15 6l-6 6 6 6")),
    Search(listOf("M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0ZM20 20l-4-4")),
    Plus(listOf("M12 5v14M5 12h14")),
    Close(listOf("M6 6l12 12M6 18 18 6")),
    Copy(listOf("M10 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2ZM4 16V6a2 2 0 0 1 2-2h10")),
}

@Composable
internal fun BoardGlyph(icon: BoardIcon, modifier: Modifier = Modifier, color: Color = LocalContentColor.current) {
    val vector = remember(icon) {
        ImageVector.Builder(icon.name, 24.dp, 24.dp, 24f, 24f).apply {
            icon.paths.forEach { path ->
                addPath(PathParser().parsePathString(path).toNodes(), fill = null,
                    stroke = SolidColor(Color.Black), strokeLineWidth = 1.8f,
                    strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round)
            }
        }.build()
    }
    Icon(vector, contentDescription = null, modifier = modifier.size(22.dp), tint = color)
}

@Composable
internal fun BoardIconButton(icon: BoardIcon, label: String, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides 0.dp) {
        IconButton(onClick, enabled = enabled, modifier = modifier.size(40.dp).semantics { contentDescription = label }) {
            BoardGlyph(icon, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = if (enabled) 1f else .38f))
        }
    }
}

@Composable
internal fun SectionCard(
    title: String? = null,
    description: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp))
            .background(MaterialTheme.colorScheme.surface).padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (title != null) Text(title, style = MaterialTheme.typography.titleSmall)
        if (description != null) Text(description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        content()
    }
}

@Composable
internal fun MakeField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    placeholder: String = "",
    minLines: Int = 1,
    enabled: Boolean = true,
    transformation: VisualTransformation = VisualTransformation.None,
) {
    var focused by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        BasicTextField(
            value, onValueChange, enabled = enabled,
            modifier = Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused }.semantics { contentDescription = label },
            textStyle = MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onSurface),
            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
            singleLine = minLines == 1, minLines = minLines,
            visualTransformation = transformation,
            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
            decorationBox = { inner ->
                Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(SurfaceDim)
                    .border(1.dp, if (focused) MaterialTheme.colorScheme.primary else OutlineVariant, RoundedCornerShape(12.dp)).padding(horizontal = 12.dp, vertical = 11.dp)) {
                    if (value.isEmpty()) Text(placeholder, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    inner()
                }
            },
        )
    }
}

@Composable
internal fun MakeAction(
    label: String, onClick: () -> Unit, modifier: Modifier = Modifier,
    primary: Boolean = false, danger: Boolean = false, enabled: Boolean = true,
) {
    val scheme = MaterialTheme.colorScheme
    CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides 0.dp) {
        Button(
            onClick, modifier.heightIn(min = 43.dp), enabled = enabled,
            shape = RoundedCornerShape(14.dp),
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 9.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = if (primary) scheme.primary else SurfaceHigh,
                contentColor = if (primary) scheme.onPrimary else if (danger) scheme.error else scheme.onSurface,
                disabledContainerColor = SurfaceHigh.copy(alpha = .38f),
                disabledContentColor = (if (danger) scheme.error else scheme.onSurface).copy(alpha = .38f),
            ),
            border = if (primary) null else BorderStroke(1.dp, if (danger) scheme.error.copy(alpha = .35f) else OutlineVariant),
        ) { Text(label, style = MaterialTheme.typography.labelMedium.copy(fontSize = 13.sp, lineHeight = 19.sp)) }
    }
}

@Composable
internal fun MakeChip(label: String, selected: Boolean = false, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides 0.dp) {
        Surface(
            onClick, shape = CircleShape,
            color = if (selected) scheme.primaryContainer else scheme.surface,
            contentColor = if (selected) scheme.onPrimaryContainer else scheme.onSurfaceVariant,
            border = if (selected) null else BorderStroke(1.dp, OutlineVariant),
            modifier = Modifier.heightIn(min = 37.dp).semantics {
                this.selected = selected
                role = Role.Tab
            },
        ) {
            Box(Modifier.padding(horizontal = 14.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
                Text(label, fontSize = 13.sp, lineHeight = 19.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
internal fun StatusBadge(status: String, english: Boolean) {
    val color = statusColor(status)
    Row(
        Modifier.clip(CircleShape).background(color.copy(alpha = .14f)).padding(horizontal = 10.dp, vertical = 3.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(6.dp).background(color, CircleShape))
        Text(statusLabel(status, english), color = color, style = MaterialTheme.typography.labelMedium)
    }
}

@Composable
internal fun ConnectionPill(label: String, modifier: Modifier = Modifier) {
    val color = when (label) {
        "已连接", "在线", "Connected", "Online" -> Success
        "连接中", "正在连接", "正在同步", "弱连接", "正在重连", "Connecting", "Syncing", "Unstable", "Reconnecting" -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.error
    }
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(13.dp).background(color.copy(alpha = .18f), CircleShape), contentAlignment = Alignment.Center) {
            Box(Modifier.size(7.dp).background(color, CircleShape))
        }
        Text(label, style = MaterialTheme.typography.bodySmall, color = color)
    }
}
