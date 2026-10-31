package tech.mengfei.agentboard.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Ink = Color(0xFF141612)
private val Paper = Color(0xFFE7E2D6)
private val Amber = Color(0xFFE0A045)
private val Moss = Color(0xFF8FBF7A)

private val Scheme = darkColorScheme(
    background = Ink,
    surface = Color(0xFF1C1F1A),
    surfaceVariant = Color(0xFF2A2E26),
    primary = Amber,
    onPrimary = Color(0xFF1C1408),
    secondary = Moss,
    onSecondary = Color(0xFF10200C),
    error = Color(0xFFD46A6A),
    onBackground = Paper,
    onSurface = Paper,
    onSurfaceVariant = Color(0xFFB7B2A6),
    outline = Color(0xFF3E433A),
)

@Composable
fun AgentBoardTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = Scheme, content = content)
}

fun statusColor(status: String): Color = when (status) {
    "running" -> Amber
    "succeeded" -> Moss
    "failed" -> Color(0xFFD46A6A)
    "paused" -> Color(0xFF8AA4C8)
    "stopped" -> Color(0xFF8B9183)
    else -> Color(0xFFB7B2A6)
}
