package tech.mengfei.agentboard.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Amber = Color(0xFFE0A045)
private val Moss = Color(0xFF8FBF7A)
private val Ink = Color(0xFF141612)
private val Paper = Color(0xFFE7E2D6)

private val Scheme = darkColorScheme(
    primary = Amber,
    onPrimary = Color(0xFF1C1408),
    secondary = Moss,
    onSecondary = Color(0xFF10200C),
    background = Ink,
    surface = Ink,
    onBackground = Paper,
    onSurface = Paper,
    onSurfaceVariant = Color(0xFFB7B2A6),
    error = Color(0xFFD46A6A),
)

@Composable
fun AgentBoardTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = Scheme, content = content)
}

fun statusColor(status: String): Color = when (status) {
    "stopped" -> Color(0xFF8B9183)
    "failed" -> Color(0xFFD46A6A)
    "paused" -> Color(0xFF8AA4C8)
    "succeeded" -> Moss
    "running" -> Amber
    else -> Color(0xFFB7B2A6)
}
