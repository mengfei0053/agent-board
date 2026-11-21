package tech.mengfei.agentboard.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class CommandBannersTest {
    @Test
    fun showMatchingCommandAndFormMessagesOnceButKeepDifferentErrors() {
        val timeout = "board did not acknowledge the command"
        assertEquals(listOf(timeout), commandBannerTexts(timeout, timeout))
        assertEquals(listOf(timeout, "invalid path"), commandBannerTexts(timeout, "invalid path"))
        assertEquals(listOf("invalid path"), commandBannerTexts(null, "invalid path"))
    }
}
