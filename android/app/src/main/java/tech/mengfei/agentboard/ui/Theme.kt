package tech.mengfei.agentboard.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Figma Make v4 tokens. Keep status colors independent from the primary accent.
internal val SurfaceDim = Color(0xFF0C0E12)
internal val SurfaceHigh = Color(0xFF262A34)
internal val SurfaceHighest = Color(0xFF303542)
internal val OutlineVariant = Color(0xFF35322C)
internal val Success = Color(0xFF7DD9A0)
private val Amber = Color(0xFFFFB95F)

private val Scheme = darkColorScheme(
    background = Color(0xFF12141A),
    surface = Color(0xFF1C1F27),
    surfaceVariant = SurfaceHigh,
    surfaceContainer = Color(0xFF1C1F27),
    surfaceContainerHigh = SurfaceHigh,
    surfaceContainerHighest = SurfaceHighest,
    surfaceDim = SurfaceDim,
    primary = Amber,
    onPrimary = Color(0xFF472A00),
    primaryContainer = Color(0xFF653E00),
    onPrimaryContainer = Color(0xFFFFDDB4),
    secondary = Color(0xFFC9C0B0),
    secondaryContainer = Color(0xFF4A453B),
    onSecondaryContainer = Color(0xFFE8E6E1),
    error = Color(0xFFFF8A80),
    onBackground = Color(0xFFE8E6E1),
    onSurface = Color(0xFFE8E6E1),
    onSurfaceVariant = Color(0xFFA9A59B),
    outline = Color(0xFF504C45),
    outlineVariant = OutlineVariant,
)

private fun uiText(size: Int, height: Int, weight: FontWeight = FontWeight.Normal) = TextStyle(
    fontFamily = FontFamily.SansSerif,
    fontSize = size.sp,
    lineHeight = height.sp,
    fontWeight = weight,
    letterSpacing = 0.sp,
)

private val Type = Typography(
    headlineSmall = uiText(26, 30, FontWeight.Bold),
    titleLarge = uiText(20, 26, FontWeight.Bold),
    titleMedium = uiText(16, 22, FontWeight.SemiBold),
    titleSmall = uiText(14, 20, FontWeight.Bold),
    bodyLarge = uiText(15, 21),
    bodyMedium = uiText(13, 20),
    bodySmall = uiText(12, 17),
    labelLarge = uiText(14, 20, FontWeight.SemiBold),
    labelMedium = uiText(12, 17, FontWeight.SemiBold),
    labelSmall = uiText(11, 16, FontWeight.SemiBold),
)

@Composable
fun AgentBoardTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = Scheme,
        typography = Type,
        shapes = Shapes(
            small = RoundedCornerShape(10.dp),
            medium = RoundedCornerShape(16.dp),
            large = RoundedCornerShape(24.dp),
        ),
        content = content,
    )
}

fun statusColor(status: String): Color = when (status) {
    "running", "paused" -> Color(0xFFB8A0FF)
    "succeeded" -> Success
    "failed" -> Color(0xFFFF8A80)
    "stopped" -> Color(0xFFC9C0B0)
    "archived" -> Color(0xFF8E8A82)
    else -> Color(0xFFA9A59B)
}
