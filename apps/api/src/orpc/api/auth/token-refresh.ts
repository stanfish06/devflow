import { issueLocalAccessToken } from '../../../devflow/local-auth'
import logger from '../../../logger'
import { apiBasePublic } from '../../base'

/** Issues a fresh local access token; the refresh token is passed back unchanged. */
export const refreshTokenProcedure = apiBasePublic.auth.token.refresh.handler(async ({ input, errors }) => {
	try {
		const { accessToken } = await issueLocalAccessToken()
		return { accessToken, refreshToken: input.refreshToken }
	} catch (error) {
		logger.error(error, 'Failed to refresh token')
		throw errors.BAD_REQUEST({ data: { message: 'Failed to refresh token' } })
	}
})
