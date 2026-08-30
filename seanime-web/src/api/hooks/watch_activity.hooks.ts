import { useServerQuery } from "@/api/client/requests"
import { API_ENDPOINTS } from "@/api/generated/endpoints"
import { Models_MediaWatchActivity } from "@/api/generated/types"

/**
 * Watch activity recorded by Seanime itself (any player, manual tracking, update-progress endpoints).
 * Independent of AniList's timestamps.
 */
export function useGetMediaWatchActivity() {
    return useServerQuery<Array<Models_MediaWatchActivity>>({
        endpoint: API_ENDPOINTS.WATCH_ACTIVITY.GetMediaWatchActivity.endpoint,
        method: API_ENDPOINTS.WATCH_ACTIVITY.GetMediaWatchActivity.methods[0],
        queryKey: [API_ENDPOINTS.WATCH_ACTIVITY.GetMediaWatchActivity.key],
        enabled: true,
    })
}
