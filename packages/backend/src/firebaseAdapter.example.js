/*
 This is a reference adapter showing where Firebase Functions integration hooks in.
 Keep the domain logic in ./api/functions.js and call it from Firebase handlers.

 Example (pseudo):

 import { onCall } from "firebase-functions/v2/https";
 import { createRideRequest } from "./api/functions.js";

 export const createRideRequestFn = onCall(async (request) => {
   const result = await createRideRequest({ repository, ...request.data });
   return result;
 });
*/
