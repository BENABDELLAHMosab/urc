import {getConnecterUser, triggerNotConnected} from "../lib/session";
// import { Redis } from '@upstash/redis';
// const PushNotifications = require("@pusher/push-notifications-server");

export default async (request, response) => {
    try {
        const user = await getConnecterUser(request);
        if (user === undefined || user === null) {
            console.log("Not connected");
            return triggerNotConnected(response);
        }

        const message = await request.body;

        // TODO : save message

        response.send("OK");
    } catch (error) {
        console.error("Message request failed");
        response.status(500).json(error);
    }
};
