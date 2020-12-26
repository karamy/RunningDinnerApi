//--------Dependencies-------//

const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
const { pool } = require('./config')
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const serviceAccount = require("./runningdinnersms-firebase-adminsdk-vd0pu-075efce3ba.json");
const { Client } = require("@googlemaps/google-maps-services-js");

//--------Initialization--------//

const app = express()
const accessTokenSecret = 'carloebbasta';
const refreshTokenSecret = 'refreshcarloebbasta';
const H24 = 86400; // Indica i secondi in un giorno
const MaxAvgDistance = 80; // Indica la massima distanza media (in km) accettabile per potersi iscrivere alla cena
const ElaboraCeneInterval = 60000; // Indica (in ms) ogni quanto lanciare l'elaborazione delle cene per generare gli eventi cena e lanciare le notifiche per gli eventi che passano di fase

// Elenco di refresh tokens contenenti quelli validi. Dal momento che il refresh token
// non scade mai (per non sbattere mai fuori gli utenti), scelto per ora di mantenere 
// la struttura in memoria, che quindi non sopravvive al riavvio del server, 
// il quale sbatte fuori tutti 
const refreshTokens = [];

app.use(bodyParser.json({ limit: '50mb' })); // Configurato per rimuovere il limite di dimensioni del pacchetto http che impediva la registrazione utente
app.use(bodyParser.urlencoded({ extended: true }))
app.use(cors()) // Utilizzo libreria CORS per configurare domini da cui ricevere chiamata (nel caso dell'app devo impostare ALL)

// Configurazione Firebase
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://runningdinnersms.firebaseio.com"
});

console.warn("App Avviata: versione " + process.env.VERSION);

//--------Utility Functions-------//

// Authorization Middleware
const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (authHeader) {
    const token = authHeader.split(' ')[1];

    jwt.verify(token, accessTokenSecret, (err, user) => {
      if (err) {
        // Token non valido o scaduto, ritorno unauthorized
        return res.status(401).send('Invalid token');
      }

      req.user = user; // Imposto lo user nelle chiamate autenticate in modo che gli endpoint lo abbiano a disposizione
      next();
    });
  } else {
    res.status(401).send('No authorization header');
  }
};

// Funzione che esegue la rollback di una transazione
const rollback = function (pool, response, err) { // Funzione che esegue la rollback dall'ultima begin
  console.log(err);
  pool.query('ROLLBACK', function () {
    response.status(500).json({ message: 'errore, effettuo il rollback' })
  });
};

// Funzione che invia una o più notifiche push
const sendNotification = function (userToken, notificationTitle, notificationBody, notificationData) {
  // Genero le informazioni da inviare nella notifica
  const notificationMsg = {
    data: {
      msg: JSON.stringify(notificationData)
    },
    notification: {
      title: notificationTitle,
      body: notificationBody,
    },
    android: { // Imposto di suonare su Android
      notification: {
        sound: "default"
      }
    }
  };

  // Invio notifica tramite Firebase Admin, lanciando una delle due funzioni se il parametro è un array
  if (Array.isArray(userToken)) {
    notificationMsg.tokens = userToken;
    admin.messaging().sendMulticast(notificationMsg)
      .then((firebaseResponse) => {
        console.log('Notifiche multiple inviate con successo');
      })
      .catch((error) => {
        console.log('Errore invio notifiche multiple:', error);
      });
  } else {
    notificationMsg.token = userToken;
    admin.messaging().send(notificationMsg)
      .then((firebaseResponse) => {
        console.log('Notifica inviata con successo');
      })
      .catch((error) => {
        console.log('Errore invio notifica:', error);
      });
  }
};

// Funzione che calcola la distanza media tra gli utenti partecipanti (group_address) alla cena e lo user
const calcDistance = function (userAddress, otherUsersAddresses) {
  return new Promise(async function (resolve) {
    let distance = 0;
    // Per ogni altro group_address presente nella cena calcolo la distanza dallo user
    for (let i = 0; i < otherUsersAddresses.length; i++) {
      res = await getDistance(userAddress, otherUsersAddresses[i]);
      distance += Number(res);
    };

    // Calcolo la distanza media
    const avgDistance = Math.round(distance / otherUsersAddresses.length);
    resolve(avgDistance);
  });
}

// Funziona che ottiene la distanza (da Maps) tra due indirizzi
const getDistance = function (userAddress, otherAddress) {
  return new Promise(function (resolve, reject) {
    const client = new Client({});
    client
      .directions({
        params: {
          origin: userAddress,
          destination: otherAddress,
          key: "AIzaSyD18at-7iHsmjzYgGyAIrvysftwnkyK12o"
        },
        timeout: 1000,
      })
      .then((r) => {
        // Restituisco la distanza senza la stringa "km" presente di default
        resolve(r.data.routes[0].legs[0].distance.text.match(/\d+\.?\d*/)[0]);
      })
      .catch((e) => {
        console.log('Richiesta fallita, errore: ', e);
        reject()
      });
  });
}

// Funzioni per calcolare la distanza in linea d'aria
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
  var R = 6371; // Raggio della terra in km
  var dLat = deg2rad(lat2 - lat1);
  var dLon = deg2rad(lon2 - lon1);
  var a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2)
    ;
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  var d = R * c; // Distanza in km
  return d;
}
function deg2rad(deg) {
  return deg * (Math.PI / 180)
}

// Funzione che aggiorna lo stato della cena 
// 0 - non elaborata, -1 - numero partecipanti insufficiente,
// 1 - elaborati paths, 2 - elaborati voti
const updateDinnerStatus = (dinnerId, status) => {
  pool.query('UPDATE dinners SET dinner_state = $1 WHERE dinnerid = $2', [status, dinnerId], (error, results) => {
    if (error) {
      console.warn("Cena ", dinnerId, "non aggiornata: ", error);
    }
  });
};

// Funzione che elabora le cene e genera le fasi
const elaboraCene = () => {
  console.log("Elabora cene - Start");

  // Funzione per ottenere le possibili permutazioni di un array
  const permute = (xs) => {
    let ret = [];

    for (let i = 0; i < xs.length; i = i + 1) {
      let rest = permute(xs.slice(0, i).concat(xs.slice(i + 1)));

      if (!rest.length) {
        ret.push([xs[i]])
      } else {
        for (let j = 0; j < rest.length; j = j + 1) {
          ret.push([xs[i]].concat(rest[j]))
        }
      }
    }
    return ret;
  };

  // Array di paths da confrontare in tutte le possibili combinazioni dell'array di gruppi
  const dinnerPaths = [
    [1, 4, 9],
    [1, 5, 2],
    [1, 3, 8],
    [6, 4, 8],
    [6, 5, 9],
    [6, 3, 2],
    [7, 4, 2],
    [7, 5, 8],
    [7, 3, 9]
  ];

  // Recupera le coordinate di un gruppo dall'array di gruppi - coordinate
  const getLatLongGrp = (groupId, group_coordinates) => {
    let nullCoordObj = {
      lat: 0,
      lon: 0
    };
    for (var i = 0; i < group_coordinates.length; i++) {
      if (group_coordinates[i][0] == groupId) {
        return {
          lat: group_coordinates[i][1],
          lon: group_coordinates[i][2]
        }
      }
    }
    return nullCoordObj;
  };

  // Ottiene la distanza di un possibile path della cena
  const getPathDistance = (dinnerPath, permutation, group_coordinates) => {
    // Es. DinnerPath: [1, 4, 5]
    // Es. Permutation [1247, 5556, 2148, 5960, 5352, 3023, 6162, 5146, 4929]
    const coordGrp1 = getLatLongGrp(permutation[dinnerPath[0] - 1], group_coordinates);
    const coordGrp2 = getLatLongGrp(permutation[dinnerPath[1] - 1], group_coordinates);
    const coordGrp3 = getLatLongGrp(permutation[dinnerPath[2] - 1], group_coordinates);

    // Distanza 1-4
    const d1 = getDistanceFromLatLonInKm(coordGrp1.lat, coordGrp1.lon, coordGrp2.lat, coordGrp2.lon);
    // Distanza 4-5 
    const d2 = getDistanceFromLatLonInKm(coordGrp2.lat, coordGrp2.lon, coordGrp3.lat, coordGrp3.lon);

    return d1 + d2;
  };

  const getTotalDistance = (permutation, group_coordinates) => { // Ottiene la distanza totale di una possibile permutazione
    let totalDistance = 0;

    dinnerPaths.forEach((dinnerPath) => { // Per ogni path
      totalDistance += getPathDistance(dinnerPath, permutation, group_coordinates);
    });

    return totalDistance;
  };

  // Invia notifica ai partecipanti del gruppo che la cena è annullata
  const sendCanceledDinnerNotification = function (userTokens) {
    if (!userTokens.length) {
      // Nessuno verrà notificato della cena annullata
      console.warn('ElaboraCena - Utenti della cena annullata non abilitati a ricevere notifiche push');
    } else {
      // Genero le informazioni da inviare nella notifica
      const notificationMsgBody = {
        type: 'updateParams'
      };

      // Invio notifiche
      sendNotification(userTokens, "Cena annullata",
        "Purtroppo la cena a cui partecipi è stata annullata",
        notificationMsgBody
      );
    }
  };

  // Invia notifica ai partecipanti del gruppo che la cena è stata generata
  const sendComputedDinnerNotification = function (userTokens) {
    if (!userTokens.length) {
      // Nessuno verrà notificato della cena annullata
      console.warn('ElaboraCena - Utenti della cena elaborata non abilitati a ricevere notifiche push');
    } else {
      // Genero le informazioni da inviare nella notifica
      const notificationMsgBody = {
        type: 'updateParams'
      };

      // Invio notifiche
      sendNotification(userTokens, "Cena creata",
        "L'evento cena è iniziato!",
        notificationMsgBody
      );
    }
  };

  // Ottengo tutte le cene per cui now() è maggiore o uguale a un giorno prima dell'inizio cena,
  // senza entries in dinners_detPaths e che non sono state ancora elaborate
  pool.query("SELECT dinners.*, array_agg(array[dinners_detgroups.groupid,users.address_lat,users.address_lon]) AS group_coordinates, array_agg(dinners_detgroups.groupid) AS groupids FROM dinners INNER JOIN dinners_detgroups ON dinners.dinnerid = dinners_detgroups.dinnerid INNER JOIN groups_users ON dinners_detgroups.groupid = groups_users.groupid INNER JOIN users ON groups_users.userid = users.userid INNER JOIN groups_users AS gu ON gu.userid = users.userid WHERE gu.house = true AND dinners.dinnerid NOT IN (SELECT dinnerid FROM dinners_detpaths) AND  (SELECT (NOW() + interval '1' day) AT TIME ZONE 'GMT-2') >= dinner_date and dinner_state = 0 group by dinners.dinnerid", (error, results) => {
    if (error) {
      console.error('Elabora cene: errore query', error);
    } else {
      let dinnerToElab;
      let groupCoordinates;
      let permutations;
      let groupIds;
      let totalDistance;
      let avgDistance;
      let pathsResult; // Array del tipo [ permutazione, distanza ]
      let queryArray;
      let winnerPermutation;
      let insertQueryText; // Testo della query di insert in dinners_detPaths
      let userTokens;

      if (results.rows.length == 0) {
        console.log("Elaborazione cene End - Nessuna cena da elaborare");
      }

      for (var i = 0; i < results.rows.length; i++) { // Per ogni cena
        // Ottengo i dati della cena e i gruppi che vi partecipano
        dinnerToElab = results.rows[i];
        groupCoordinates = dinnerToElab.group_coordinates;
        groupIds = dinnerToElab.groupids;
        userTokens = [];

        console.log("Elaborazione cena", dinnerToElab.dinnerid, dinnerToElab.dinner_description);

        // Ottengo i token dei partecipanti alla cena
        pool.query('SELECT users.firebase_token, users.name FROM users INNER JOIN groups_users ON (users.userid = groups_users.userid) INNER JOIN dinners_detgroups ON (dinners_detgroups.groupid = groups_users.groupid) WHERE dinners_detgroups.dinnerid = ' + dinnerToElab.dinnerid + ' AND users.firebase_token IS NOT NULL AND users.firebase_token <> \'\' ',
          (error, res) => {
            for (var i = 0; i < res.rows.length; i++) {
              if (res.rows[i]['firebase_token']) {
                userTokens.push(res.rows[i]['firebase_token']);
              }
            }

            if (groupIds.length < 9) {
              console.log("Cena annullata per mancanza numero minimo partecipanti =(");
              sendCanceledDinnerNotification(userTokens);
              updateDinnerStatus(dinnerToElab.dinnerid, -1);
            } else {

              permutations = permute(groupIds);
              pathsResult = [];
              queryArray = [];

              permutations.forEach((permutation) => { // Per ogni permutazione
                totalDistance = getTotalDistance(permutation, groupCoordinates);
                avgDistance = totalDistance / 9; // Ottengo la distanza media

                pathsResult.push( // Aggiungo il path all'array di risultati
                  {
                    permutation: permutation,
                    avgDistance: avgDistance
                  }
                );
              });

              // Ordino l'array di permutazioni per aver i migliori path
              pathsResult = pathsResult.sort((a, b) => (a.avgDistance > b.avgDistance) ? 1 : ((b.avgDistance > a.avgDistance) ? -1 : 0));
              winnerPermutation = pathsResult[0];

              console.log("Dinner " + dinnerToElab.dinnerid + " - Fine elaborazione, best permutation", winnerPermutation);

              // Ottengo la struttura per generare le query
              dinnerPaths.forEach((dinnerPath, idx) => {
                queryArray[idx] = {
                  groupId: winnerPermutation.permutation[idx],
                  values: [
                    winnerPermutation.permutation[dinnerPath[0] - 1],
                    winnerPermutation.permutation[dinnerPath[1] - 1],
                    winnerPermutation.permutation[dinnerPath[2] - 1]
                  ]
                };
              });

              // Lancio le query per generare dinners_detPaths
              insertQueryText = "INSERT INTO dinners_detpaths (dinnerid, groupid, first_group_house, second_group_house, third_group_house) VALUES ";
              queryArray.forEach((queryStructure, idx) => {
                if (idx != 0) insertQueryText += ", ";
                insertQueryText += "(" + dinnerToElab.dinnerid + ", " + queryStructure.groupId + ", " + queryStructure.values[0] + ", " + queryStructure.values[1] + ", " + queryStructure.values[2] + ")";
              });

              pool.query(insertQueryText, (error, results) => {
                if (error) {
                  console.error('Elabora cene: errore query', error);
                } else {
                  sendComputedDinnerNotification(userTokens);
                  console.log("Elaborazione cena " + dinnerToElab.dinnerid + " - End");
                  updateDinnerStatus(dinnerToElab.dinnerid, 1);
                }
              });
            }
          });
      }
    }
  })
};

// Funzione che elabora i passaggi di fase della cena
const elaboraFasi = () => {
  console.log("Elabora fasi - Start");

  // Invia notifica ai partecipanti del gruppo che la fase è cambiata
  const sendPhaseChangeNotification = function (userTokens, notificationText) {
    if (!userTokens.length) {
      // Nessuno verrà notificato del cambio fase
      console.warn('ElaboraFasi - Utenti della fase non abilitati a ricevere notifiche push');
    } else {
      // Genero le informazioni da inviare nella notifica
      const notificationMsgBody = {
        type: 'updateParams'
      };

      // Invio notifiche
      sendNotification(userTokens, "Cambio fase",
        notificationText,
        notificationMsgBody
      );
    }
  };

  // Invia la notifica e aggiorna la cena al cambio fase
  const changePhase = function (dinnerId, notificationText, nextPhase) {
    // Ottengo i token dei partecipanti alla cena
    pool.query('SELECT users.firebase_token, users.name FROM users INNER JOIN groups_users ON (users.userid = groups_users.userid) INNER JOIN dinners_detgroups ON (dinners_detgroups.groupid = groups_users.groupid) WHERE dinners_detgroups.dinnerid = ' + dinnerId + ' AND users.firebase_token IS NOT NULL AND users.firebase_token <> \'\' ',
      (error, res) => {
        const userTokens = [];
        for (var i = 0; i < res.rows.length; i++) {
          if (res.rows[i]['firebase_token']) {
            userTokens.push(res.rows[i]['firebase_token']);
          }
        }
        sendPhaseChangeNotification(userTokens, notificationText);
        updateDinnerStatus(dinnerId, nextPhase);
      });
  };

  // Fase 1
  pool.query("SELECT * from dinners WHERE NOW() AT TIME ZONE 'GMT-1' >= dinner_date + interval '-1' hour  AND dinner_state = 1", (error, results) => {
    if (error) {
      console.error('Elabora fase 1: errore query', error);
    } else {
      let dinnerToElab;

      if (results.rows.length == 0) {
        console.log("Elaborazione fase 1 end - Nessuna cena da elaborare");
      }

      for (var i = 0; i < results.rows.length; i++) {
        dinnerToElab = results.rows[i];
        console.log("Elaborazione fase 1", dinnerToElab.dinnerid, dinnerToElab.dinner_description);
        changePhase(dinnerToElab.dinnerid, "Inizia la fase 1!", 2);
      }
    }
  });

  // Fase 2
  pool.query("SELECT * from dinners WHERE NOW() AT TIME ZONE 'GMT-1' >= (dinner_date + interval '35' minute) AND dinner_state = 2", (error, results) => {
    if (error) {
      console.error('Elabora fase 2: errore query', error);
    } else {
      let dinnerToElab;

      if (results.rows.length == 0) {
        console.log("Elaborazione fase 2 end - Nessuna cena da elaborare");
      }

      for (var i = 0; i < results.rows.length; i++) {
        dinnerToElab = results.rows[i];
        console.log("Elaborazione fase 2", dinnerToElab.dinnerid, dinnerToElab.dinner_description);
        changePhase(dinnerToElab.dinnerid, "Inizia la fase 2!", 3);
      }
    }
  });

  // Fase 3
  pool.query("SELECT * from dinners WHERE NOW() AT TIME ZONE 'GMT-1' >= (dinner_date + interval '95' minute) AND dinner_state = 3", (error, results) => {
    if (error) {
      console.error('Elabora fase 3: errore query', error);
    } else {
      let dinnerToElab;

      if (results.rows.length == 0) {
        console.log("Elaborazione fase 3 end - Nessuna cena da elaborare");
      }

      for (var i = 0; i < results.rows.length; i++) {
        dinnerToElab = results.rows[i];
        console.log("Elaborazione fase 3", dinnerToElab.dinnerid, dinnerToElab.dinner_description);
        changePhase(dinnerToElab.dinnerid, "Inizia la fase 3!", 4);
      }
    }
  });

  // Fase 4
  pool.query("SELECT * from dinners WHERE NOW() AT TIME ZONE 'GMT-1' >= (dinner_date + interval '160' minute) AND dinner_state = 4", (error, results) => {
    if (error) {
      console.error('Elabora fase 4: errore query', error);
    } else {
      let dinnerToElab;

      if (results.rows.length == 0) {
        console.log("Elaborazione fase 4 end - Nessuna cena da elaborare");
      }

      for (var i = 0; i < results.rows.length; i++) {
        dinnerToElab = results.rows[i];
        console.log("Elaborazione fase 4", dinnerToElab.dinnerid, dinnerToElab.dinner_description);
        changePhase(dinnerToElab.dinnerid, "E' ora di votare!", 5);
      }
    }
  });
};

// Funzione che elabora i voti della cena
// NB Scelto apposta di rendere le elaborazioni parallele evitando di utilizzare rollback per potersi
// limitare ad aggiornare lo stato cena e in automatico le tabelle non ancora riempite si riempiono mentre
// le altre vanno in DO NOTHING a causa di chiave duplicata, ma almeno evitiamo di cancellare tutto a ogni test
const elaboraVoti = () => {
  console.log("Elabora voti - Start");

  // Invia la notifica e aggiorna la cena una volta elaborati i voti e i badges
  const saveVoteComplete = function (dinnerId) {
    // Ottengo i token dei partecipanti alla cena
    pool.query('SELECT users.firebase_token, users.name FROM users INNER JOIN groups_users ON (users.userid = groups_users.userid) INNER JOIN dinners_detgroups ON (dinners_detgroups.groupid = groups_users.groupid) WHERE dinners_detgroups.dinnerid = ' + dinnerId + ' AND users.firebase_token IS NOT NULL AND users.firebase_token <> \'\' ',
      (error, res) => {
        const userTokens = [];

        for (var i = 0; i < res.rows.length; i++) {
          if (res.rows[i]['firebase_token']) {
            userTokens.push(res.rows[i]['firebase_token']);
          }
        }

        if (!userTokens.length) {
          // Nessuno verrà notificato del cambio fase
          console.warn('ElaboraVoti - Utenti della fase non abilitati a ricevere notifiche push');
        } else {
          // Genero le informazioni da inviare nella notifica
          const notificationMsgBody = {
            type: 'updateParams'
          };

          // Invio notifiche
          sendNotification(userTokens, "Votazione terminata!",
            "La cena è terminata, visualizza i vincitori",
            notificationMsgBody
          );
        }

        updateDinnerStatus(dinnerId, 6);
      });
  };

  // Aggiunge un badge all'utente
  const insertDinnerBadge = function (userId, badgeId) {
    pool.query('INSERT INTO badges_detusers (user_id, badge_id, progress) VALUES ($1, $2, 1) ON CONFLICT (user_id, badge_id) DO UPDATE SET progress = badges_detusers.progress + 1', [userId, badgeId], (error) => {
      if (error) {
        console.error('Insert dinner badge: errore query', error);
      }
    });
  };

  // Salva il vincitore di categoria in dinners_detwinners e assegna il relativo badge
  const insertDinnerVote = function (dinnerId, badgeId, groupId, userId, vote, hasVoted) {
    pool.query("INSERT INTO dinners_detwinners (dinnerid, badgeid, groupid, userid, vote, has_voted) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING", [dinnerId, badgeId, groupId, userId, vote, hasVoted], (error) => {
      if (error) {
        console.error('Insert dinner vote: errore query', error);
      } else {
        if (hasVoted) { // Assegno il badge solo se l'utente ha votato
          insertDinnerBadge(userId, badgeId);
        }
      }
    });
  };

  // Riempie tabella dinner_history con elenco utenti partecipanti
  const fillDinnerhistory = function (dinnerId) {
    pool.query("INSERT INTO dinner_history (dinnerid, userid) SELECT " + dinnerId + " as dinnerid, gu.userid FROM dinners_detgroups  INNER JOIN groups_users gu on dinners_detgroups.groupid = gu.groupid where dinnerid = " + dinnerId + " ON CONFLICT DO NOTHING", (error) => {
      if (error) {
        console.error('Insert dinner_history: errore query', error);
      }
    });
  };

  // Ottengo tutte le cene terminate
  pool.query("SELECT * from dinners  WHERE NOW() AT TIME ZONE 'GMT-1' >= dinner_date + interval '180' minute  AND dinner_state = 5", (error, results) => {
    if (error) {
      console.error('Elabora voti: errore query', error);
    } else {
      let dinnerId;
      let usersElaborati;

      if (results.rows.length == 0) {
        console.log("Elaborazione voti end - Nessuna cena da elaborare");
      }

      for (var i = 0; i < results.rows.length; i++) { // Per ogni cena terminata
        dinnerId = results.rows[i]["dinnerid"];

        console.log("Elaborazione voti cena", dinnerId);

        // Ottengo i vincitori della cena per ogni categoria
        pool.query("SELECT t1.category, t1.groupid, t1.userid, t1.vote,t1.has_voted,dtb.badgeid from (SELECT dinnerid, 'dinner' AS category, groupid, userid, (firstcat_avg + secondcat_avg + thirdcat_avg + fourthcat_avg + fifthcat_avg) AS vote, has_voted FROM dinners_detvotes INNER JOIN (SELECT max(firstcat_avg + secondcat_avg + thirdcat_avg + fourthcat_avg + fifthcat_avg) AS allsum FROM dinners_detvotes) AS dv1 ON firstcat_avg + secondcat_avg + thirdcat_avg + fourthcat_avg + fifthcat_avg = dv1.allsum WHERE dinnerid = " + dinnerId + " UNION ALL (SELECT dinnerid, 'firstcat' AS category, groupid, userid, (firstcat_avg) AS vote, has_voted FROM dinners_detvotes INNER JOIN (SELECT max(firstcat_avg) AS maxvote FROM dinners_detvotes) AS dv1 ON firstcat_avg = dv1.maxvote WHERE dinnerid = " + dinnerId + ") UNION ALL (SELECT dinnerid, 'secondcat' AS category, groupid, userid, (secondcat_avg) AS vote, has_voted FROM dinners_detvotes INNER JOIN (SELECT max(secondcat_avg) AS maxvote FROM dinners_detvotes) AS dv1 ON secondcat_avg = dv1.maxvote WHERE dinnerid = " + dinnerId + ") UNION ALL (SELECT dinnerid, 'thirdcat' AS category, groupid, userid, (thirdcat_avg) AS vote, has_voted FROM dinners_detvotes INNER JOIN (SELECT max(thirdcat_avg) AS maxvote FROM dinners_detvotes) AS dv1 ON thirdcat_avg = dv1.maxvote WHERE dinnerid = " + dinnerId + ") UNION ALL (SELECT dinnerid, 'fourthcat' AS category, groupid, userid, (fourthcat_avg) AS vote, has_voted FROM dinners_detvotes INNER JOIN (SELECT max(fourthcat_avg) AS maxvote FROM dinners_detvotes) AS dv1 ON fourthcat_avg = dv1.maxvote WHERE dinnerid = " + dinnerId + ") UNION ALL (SELECT dinnerid, 'fifthcat' AS category, groupid, userid, (fifthcat_avg) AS vote, has_voted FROM dinners_detvotes INNER JOIN (SELECT max(fifthcat_avg) AS maxvote FROM dinners_detvotes) AS dv1 ON fifthcat_avg = dv1.maxvote WHERE dinnerid = " + dinnerId + ")) as t1 INNER JOIN dinners On t1.dinnerid = dinners.dinnerid LEFT JOIN  dinners_types_badges dtb on dinners.dinner_type = dtb.dinner_type AND t1.category = dtb.category  ", (error, results) => {
          if (error) {
            console.error('Elabora voti della cena', dinnerid, ': errore query', error);
          } else {

            // Per ogni riga dei vincitori di categoria assegno il relativo voto e badge
            usersElaborati = [];
            for (var j = 0; j < results.rows.length; j++) {
              insertDinnerVote(dinnerId, results.rows[j]["badgeid"], results.rows[j]["groupid"], results.rows[j]["userid"], results.rows[j]["vote"], results.rows[j]["has_voted"]);

              // Assegnazione badge "di cena" agli utenti (da completare, per ora messo solo badge 8)
              if (!usersElaborati.includes(results.rows[j]["userid"])) {
                // 1) Badge partecipazione cena
                insertDinnerBadge(results.rows[j]["userid"], 8);

                usersElaborati.push(results.rows[j]["userid"]);
              }
            }

            fillDinnerhistory(dinnerId); // Riempio tabella dinner_history
            saveVoteComplete(dinnerId); // Aggiorno stato cena e invio notifiche
          }
        });
      }
    }
  });
};

//--------Routes Functions-------//

const getUsers = (request, response) => {
  pool.query('SELECT * FROM users', (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      response.status(200).json(results.rows)
    }
  })
};

const addUser = (request, response) => {
  const { name, address, phoneNumber, birthDate, profilePhoto, latitude, longitude } = request.body

  console.log("Inserimento nuovo utente: " + request.body.name);

  pool.query('INSERT INTO users (name, address, phone_number, birth_date, profile_photo, created_on, address_lat, address_lon) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [name, address, phoneNumber, birthDate, profilePhoto, new Date(), latitude, longitude], error => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      response.status(201).json({ status: 'success', message: 'User added.' })
    }
  })
};

const checkUserExists = (request, response) => {
  const { phone_number } = request.body;

  pool.query('SELECT count(*) FROM users WHERE phone_number =\'' + phone_number + '\'', (error, results) => {
    if (error) {
      response.status(500).json({ message: 'errore query' })
    } else {
      response.status(200).json(results.rows[0].count == 1)
    }
  })
};

const updateUser = (req, res) => {
  const { user } = req.body;

  console.log("UpdateUser - User: " + req.user.userid);

  // Aggiorno informazioni dell'utente
  pool.query('UPDATE users SET name = $1, address = $2, birth_date = $3, profile_photo = $4, address_lat = cast($6 as double precision), address_lon = cast($7 as double precision) WHERE phone_number = $5', [user.name, user.address, user.birth_date, user.profile_photo, user.phone_number, user.latitude, user.longitude], (error, results) => {
    if (error) {
      console.warn(error);
      res.status(500).json({ message: 'errore query' })
    } else {
      pool.query('SELECT * FROM users WHERE phone_number = $1', [user.phone_number], (error, results) => {
        if (error) {
          console.warn(error);
          res.status(500).json({ message: 'errore query' })
        } else {
          const userEdited = results.rows[0];
          // Risposta contenente dati utente
          res.json({
            userData: userEdited
          });
        }
      })
    }
  });
};

// Ottengo tutti i badge più le eventuali descrizioni/foto della fase corrente se il progress del badge è ==! null
const getUserBadges = (req, res) => {
  const { userId } = req.body;
  pool.query('SELECT badges.badge_id, COALESCE(badges_detphase.description, badges.description) AS description, COALESCE(badges_detphase.badge_photo, badges.badge_photo) AS badge_photo, badges_detusers.progress, badges_detphase.phase FROM badges LEFT JOIN badges_detusers ON badges.badge_id = badges_detusers.badge_id AND user_id = ' + userId + 'LEFT JOIN badges_detphase ON badges.badge_id = badges_detphase.badge_id AND badges_detusers.progress >= badges_detphase.min_progress AND badges_detusers.progress <= badges_detphase.max_progress ORDER BY badge_id ', (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      const userBadges = results.rows
      // Risposta contenente badges utente
      res.json(userBadges);
    }
  });
};

// NB Rotta non utilizzata, nata per debug
// Aggiunge il badge in badges_detusers se non esiste, altrimenti lo aggiorna
const insertUserBadge = (req, res) => {
  const userData = req.body;
  console.log(userData)
  pool.query('INSERT INTO badges_detusers (user_id, badge_id, progress) VALUES ($1, $2, 1) ON CONFLICT (user_id, badge_id) DO UPDATE SET progress = badges_detusers.progress + 1', [userData.user_id, userData.badge_id], (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      console.log("Badge aggiunto")
      res.status(200).send();
    }
  })
};

// Restituisce solo i badge del partner presenti in badges_detphase (ovvero che hanno almeno fase 1)
const getPartnerBadges = (req, res) => {
  const groupData = req.body;
  console.log(groupData)
  pool.query('SELECT badges_detusers.badge_id, badges_detusers.progress, badges_detphase.badge_photo, badges_detphase.description, badges_detphase.phase FROM badges_detusers INNER JOIN groups_users ON groups_users.userid = badges_detusers.user_id INNER JOIN badges_detphase ON badges_detusers.badge_id = badges_detphase.badge_id AND badges_detusers.progress >= badges_detphase.min_progress AND badges_detusers.progress <= badges_detphase.max_progress WHERE groups_users.groupid = ' + groupData.groupId + 'AND groups_users.userid <> ' + groupData.userId + 'ORDER BY badge_id', (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      const partnerBadges = results.rows
      // Risposta contenente i badges del partner
      res.json(partnerBadges);
    }
  })
};

// Restituisce solo i badge del contatto presenti in badges_detphase (ovvero che hanno almeno fase 1)
const getContactBadges = (req, res) => {
  const { userId } = req.body;
  pool.query('SELECT badges_detusers.badge_id, badges_detphase.badge_photo FROM badges_detusers INNER JOIN badges_detphase ON badges_detusers.badge_id = badges_detphase.badge_id AND badges_detusers.progress >= badges_detphase.min_progress AND badges_detusers.progress <= badges_detphase.max_progress WHERE badges_detusers.user_id = ' + userId + 'ORDER BY badge_id', (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      const contactBadges = results.rows
      // Risposta contenente i badges del contatto
      res.json(contactBadges);
    }
  })
};

const getFoodAllergies = (request, response) => {
  pool.query('SELECT * FROM food_allergies', (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      console.log("Ecco le intolleranze")
      // Risposta contenente la lista di tutte le intolleranze
      response.status(200).json(results.rows)
    }
  })
};

const getUserFoodAllergies = (req, res) => {
  const { userId } = req.body;
  pool.query('SELECT * FROM food_allergies INNER JOIN allergies_detusers ON food_allergies.allergy_id = allergies_detusers.allergy_id WHERE allergies_detusers.user_id = ' + userId, (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      const userAllergies = results.rows
      // Risposta contenente intolleranze utente
      res.json(userAllergies);
    }
  })
};

const getPartnerFoodAllergies = (req, res) => {
  const groupData = req.body;
  pool.query('SELECT * FROM food_allergies INNER JOIN allergies_detusers ON food_allergies.allergy_id = allergies_detusers.allergy_id INNER JOIN groups_users ON allergies_detusers.user_id = groups_users.userid WHERE groupid = ' + groupData.groupId + ' AND userid <> ' + groupData.userId, (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      const partnerAllergies = results.rows
      // Risposta contenente intolleranze del partner
      res.json(partnerAllergies);
    }
  })
};

const insertFoodAllergies = (request, response) => {
  const { userAllergy } = request.body;

  pool.query('INSERT INTO allergies_detusers (allergy_id, user_id, allergy_name) VALUES ($1, $2, $3)',
    [userAllergy.allergyId, userAllergy.userId, userAllergy.allergyName], (error) => {
      if (error) {
        console.log(error);
        response.status(500).json({ message: 'errore query' })
      } else {
        console.log("Intolleranza aggiunta")
        response.status(200).send();
      }
    }
  )
};

const deleteFoodAllergies = (request, response) => {
  const { userAllergy } = request.body;
  pool.query('DELETE FROM allergies_detusers WHERE allergy_id = $1 AND user_id = $2 AND allergy_name = $3',
    [userAllergy.allergyId, userAllergy.userId, userAllergy.allergyName], (error) => {
      if (error) {
        console.log(error);
        response.status(500).json({ message: 'errore query' })
      } else {
        console.log("Intolleranza eliminata")
        response.status(200).send();
      }
    }
  )
};

const login = (req, res) => {
  const { phone_number } = req.body;

  console.warn('Login: ' + JSON.stringify(req.body));

  pool.query('SELECT * FROM users WHERE phone_number =\'' + phone_number + '\'', (error, results) => {
    if (error) {
      console.warn(error);
      res.status(500).json({ message: 'errore query' })
    } else {
      user = results.rows[0];
      if (user) {
        // Aggiorno le informazioni sull'ultimo accesso dell'utente
        pool.query('UPDATE users SET last_login = $1 WHERE phone_number = $2', [new Date(), phone_number], (error, results) => {
          if (error) {
            console.warn(error);
            res.status(500).json({ message: 'errore query update last_login' });
          } else {
            // Genero le informazioni di sessione memorizzate nel token (rimuovo profile_photo)
            const userData = {
              userid: user.userid,
              name: user.name,
              address: user.address,
              phone_number: user.phone_number,
              birth_date: user.birth_date,
              refreshedOn: new Date()
            };
            // Genero access token e refresh token, impostando la durata a un giorno
            const accessToken = jwt.sign(userData, accessTokenSecret, { expiresIn: H24 });
            const refreshToken = jwt.sign(userData, refreshTokenSecret);
            refreshTokens.push(refreshToken); // Aggiungo il refreshToken alla lista in memoria, non sopravvive a riavvio server

            // Risposta contenente token e dati utente
            res.json({
              accessToken: accessToken,
              refreshToken: refreshToken,
              userData: user
            });
          }
        });
      } else {
        res.send('Incorrect credentials o.O');
      }
    }
  })
};

const logout = (request, response) => {
  const { userId } = request.body;

  console.warn('Logout: ' + userId);

  pool.query('UPDATE users SET firebase_token = NULL WHERE userid = ' + userId, (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      response.status(200).send();
    }
  })
};

const refreshToken = (req, res) => {
  const refreshToken = req.body.refreshToken;

  if (!refreshTokens.includes(refreshToken)) {
    return res.status(404).send('Refresh token not found (server riavviato)');
  }

  // Verifico refresh token
  jwt.verify(refreshToken, refreshTokenSecret, (err, user) => {
    if (err) {
      return res.status(401).send('Invalid refresh token');
    }

    // Creo il nuovo access token modificando il valore refreshedOn per generarne uno
    // diverso, altrimenti la funzione 'sign' genererebbe lo stesso di prima già scaduto
    // Inoltre aumentata leggermente validità altrimenti per qualche motivo utilizzandolo
    // nasce scaduto
    user.refreshedOn = new Date();
    const newAccessToken = jwt.sign(user, accessTokenSecret, { expiresIn: H24 + 100 });

    res.json({
      accessToken: newAccessToken
    });
  });
};

const updateFirebaseToken = (request, response) => {
  const { firebaseToken } = request.body;

  console.warn("UpdateToken for user: " + request.user.userid);

  // Valorizzo (o aggiorno) il token assegnato all'utente
  pool.query('UPDATE users SET firebase_token = $1 WHERE userid = $2', [firebaseToken, request.user.userid], (error, results) => {
    if (error) {
      console.warn(error);
      res.status(500).json({ message: 'errore query update firebase token' });
    } else {
      response.status(200).send();
    }
  });
};

const getParams = (request, response) => {
  const rdParams = {
    groupId: 0 // Valorizzo di base il groupId per evitare errori in query successive
  };

  console.log("GetParams - User: " + request.user.userid);

  // 1 - GroupId
  pool.query('SELECT * FROM groups_users WHERE userid = ' + request.user.userid,
    (error, results) => {
      if (error) {
        console.warn(error);
        response.status(500).json({ message: 'errore query' })
      } else {
        if (results.rows.length > 0) {
          // Scelto di selezionare il primo gruppo a cui fa parte l'utente, anche se teoricamente non
          // può far parte di più gruppi contemporaneamente
          rdParams.groupId = results.rows[0]['groupid'];
        }

        // 2 - DinnerId
        pool.query('SELECT * FROM dinners INNER JOIN dinners_detgroups ON dinners.dinnerid = dinners_detgroups.dinnerid WHERE dinners.dinner_date >= current_date AND dinner_state <> 6 AND dinner_state <> -1 AND groupid = ' + rdParams.groupId,
          (error, results) => {
            if (error) {
              console.warn(error);
              response.status(500).json({ message: 'errore query' })
            } else {
              if (results.rows.length > 0) {
                // Scelto di selezionare la prima cena a cui fa parte l'utente, anche se teoricamente non
                // può far parte di più cene contemporaneamente
                rdParams.dinnerId = results.rows[0]['dinnerid'];
              }

              // Ritorno i parametri dell'utente
              response.status(200).json(rdParams);
            }
          });
      }
    });
};

const compareContacts = (request, response) => {
  const localContacts = request.body;
  const resContacts = [];
  // RegEx per individuare ogni countryCode esistente
  const countryCodes = /\+(?:998|996|995|994|993|992|977|976|975|974|973|972|971|970|968|967|966|965|964|963|962|961|960|886|880|856|855|853|852|850|692|691|690|689|688|687|686|685|683|682|681|680|679|678|677|676|675|674|673|672|670|599|598|597|595|593|592|591|590|509|508|507|506|505|504|503|502|501|500|423|421|420|389|387|386|385|383|382|381|380|379|378|377|376|375|374|373|372|371|370|359|358|357|356|355|354|353|352|351|350|299|298|297|291|290|269|268|267|266|265|264|263|262|261|260|258|257|256|255|254|253|252|251|250|249|248|246|245|244|243|242|241|240|239|238|237|236|235|234|233|232|231|230|229|228|227|226|225|224|223|222|221|220|218|216|213|212|211|98|95|94|93|92|91|90|86|84|82|81|66|65|64|63|62|61|60|58|57|56|55|54|53|52|51|49|48|47|46|45|44\D?1624|44\D?1534|44\D?1481|44|43|41|40|39|36|34|33|32|31|30|27|20|7|1\D?939|1\D?876|1\D?869|1\D?868|1\D?849|1\D?829|1\D?809|1\D?787|1\D?784|1\D?767|1\D?758|1\D?721|1\D?684|1\D?671|1\D?670|1\D?664|1\D?649|1\D?473|1\D?441|1\D?345|1\D?340|1\D?284|1\D?268|1\D?264|1\D?246|1\D?242|1)\D?/g;

  console.log("CompareContacts - User: " + request.user.userid);

  if (localContacts.length > 0) {
    pool.query('SELECT users.userid, users.profile_photo, users.phone_number, CASE WHEN groups_users.groupid > 0 THEN true ELSE false END AS is_in_group FROM users LEFT JOIN groups_users ON users.userid = groups_users.userid', (error, results) => {
      if (error) {
        console.warn(error);
        response.status(500).json({ message: 'errore query' })
      } else {
        const dbContacts = results.rows;
        for (var i = 0; i < localContacts.length; i++) { // Per ogni utente su App
          for (var j = 0; j < dbContacts.length; j++) { // Per ogni utente su DB
            for (var x = 0; x < localContacts[i].phoneNumbers.length; x++) { // Per ogni numero di telefono
              if ((localContacts[i].phoneNumbers[x] === dbContacts[j].phone_number || localContacts[i].phoneNumbers[x] === dbContacts[j].phone_number.replace(countryCodes, '')) && // Controllo se i numeri combaciano considerando con e senza prefisso
                !resContacts.find(contact => contact.phoneNumbers === localContacts[i].phoneNumbers[x] || contact.phoneNumbers === localContacts[i].phoneNumbers[x].replace(countryCodes, '') || contact.phoneNumbers.replace(countryCodes, '') === localContacts[i].phoneNumbers[x])) { // Match e controllo se esiste già quel numero
                resContacts.push({
                  phoneNumbers: localContacts[i].phoneNumbers[x],
                  imageUrl: dbContacts[j].profile_photo,
                  userId: dbContacts[j].userid,
                  isInGroup: dbContacts[j].is_in_group
                });
              }
            }
          }
        }
        response.status(200).json(resContacts);
      }
    });
  } else {
    console.warn('Ricevuto array di contatti vuoto');
    response.status(200).json(resContacts);
  }
};

const inviteGroup = (request, response) => {
  const { userId: userIdToInvite, contactHouseId: contactHouseId } = request.body;

  console.warn("InviteGroup: " + userIdToInvite);

  // Check se sto invitando me stesso
  if (request.user.userid == userIdToInvite) {
    response.status(400).json({ message: 'Stai invitando te stesso!' });
    return;
  }

  // Verifico che l'utente da invitare non appartenga già ad un gruppo
  pool.query('SELECT count(*) FROM groups_users WHERE userid = ' + userIdToInvite, (error, results) => {
    if (error) {
      console.log(error);
      response.status(500).json({ message: 'errore query' })
    } else {

      if (parseInt(results.rows[0]['count']) >= 1) {
        response.status(400).json({ message: 'userId ' + userIdToInvite + ' già presente in un gruppo' })
      } else {
        // Ottengo il token dell'utente che voglio invitare
        pool.query('SELECT * FROM users WHERE userid = ' + userIdToInvite, (error, results) => {
          if (error) {
            console.log(error);
            response.status(500).json({ message: 'errore query' })
          } else {
            const userToken = results.rows[0]['firebase_token'];
            if (!userToken) {
              console.warn('Utente non abilitato a ricevere notifiche push');
              response.status(400).json("Utente non abilitato a ricevere notifiche push");
            } else {
              // Genero le informazioni da inviare nella notifica
              const notificationMsgBody = {
                type: 'confirmGroupInvite',
                userIdThatInvites: request.user.userid,
                userNameThatInvites: request.user.name,
                userIdThatInvitesHouse: request.user.userid == contactHouseId
              };

              // Invio notifica
              sendNotification(userToken, "Nuovo invito",
                "Hai un nuovo invito a partecipare ad un gruppo",
                notificationMsgBody
              );

              response.status(200).send();
            }
          }
        });
      }
    }
  });
};

const inviteGroupConfirm = (request, response) => {
  const { userId: userIdThatInvites, contactHouseId: contactHouseId } = request.body;

  console.warn("InviteGroupConfirm: " + userIdThatInvites + " a casa del gruppo " + contactHouseId);

  // Verifico che l'utente a cui confermo l'invito non appartenga già ad un gruppo
  pool.query('SELECT count(*) FROM groups_users WHERE userid = ' + userIdThatInvites, (error, results) => {
    if (error) {
      console.log(error);
      response.status(500).json({ message: 'errore query' })
    } else {

      if (parseInt(results.rows[0]['count']) >= 1) {
        response.status(400).json({ message: 'userId ' + userIdThatInvites + ' già presente in un gruppo' })
      } else {
        const sessionUserId = request.user.userid; // Ottengo lo userId dell'utente loggato dalla sessione
        const groupId = '' + sessionUserId + userIdThatInvites; // Genero un groupId concatenando gli userId dei partecipanti
        let isMyHouse = false;

        pool.query('BEGIN', function (err) {
          if (err) return rollback(pool, response, err);

          isMyHouse = sessionUserId == contactHouseId;
          pool.query('INSERT INTO groups_users (groupid, userid, house) VALUES ($1, $2, $3)',
            [groupId, sessionUserId, isMyHouse], (err) => {
              if (err) return rollback(pool, response, err);

              isMyHouse = userIdThatInvites == contactHouseId;
              pool.query('INSERT INTO groups_users (groupid, userid, house) VALUES ($1, $2, $3)',
                [groupId, userIdThatInvites, isMyHouse], (err) => {
                  if (err) return rollback(pool, response, err);

                  pool.query('COMMIT', function () {

                    // Ottengo il token dell'utente a cui voglio dare conferma di invito
                    pool.query('SELECT * FROM users WHERE userid = ' + userIdThatInvites, (error, results) => {
                      if (error) {
                        console.log(error);
                        response.status(500).json({ message: 'errore query' })
                      } else {
                        const userToken = results.rows[0]['firebase_token'];
                        if (!userToken) { // Non dovrebbe succedere perchè blocchiamo prima di confermare l'aggiunta a gruppo, ma l'utente potrebbe aver fatto logout
                          console.warn('Utente non abilitato a ricevere notifiche push');
                          response.status(400).json("Utente non abilitato a ricevere notifiche push");
                        } else {
                          // Genero le informazioni da inviare nella notifica
                          const notificationMsgBody = {
                            type: 'updateParams'
                          };

                          // Invio notifica
                          sendNotification(userToken, "Invito confermato",
                            "L'invito al gruppo è stato confermato",
                            notificationMsgBody
                          );

                          response.status(200).send();
                        }
                      }
                    });

                    response.status(200).send();
                  });
                });
            });
        });
      }
    }
  });
};

const getGroupPartner = (request, res) => {
  const { groupId } = request.body;
  const userId = request.user.userid;

  // Ottengo dati del mio partner escludendo me stesso
  pool.query('SELECT users.*, gu.address as group_address FROM users INNER JOIN groups_users ON users.userid = groups_users.userid INNER JOIN (SELECT groups_users.groupid, users.address FROM users INNER JOIN groups_users ON users.userid = groups_users.userid WHERE groups_users.house = true) as GU ON gu.groupid = groups_users.groupid WHERE groups_users.groupid = ' + groupId + ' AND groups_users.userid <> ' + userId, (error, results) => {
    if (error) {
      console.log(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      const partner = results.rows[0]
      console.log("Info partner inviati")
      // Risposta contenente dati utente
      res.json({
        userid: partner.userid,
        name: partner.name,
        address: partner.address,
        group_address: partner.group_address,
        phone_number: partner.phone_number,
        birth_date: partner.birth_date,
        profile_photo: partner.profile_photo,
      });
    }
  });
}

const leaveGroup = (request, response) => {
  const { groupId } = request.body;
  const userId = request.user.userid;
  var userToken = null; //Token dell'altro utente del mio gruppo

  console.warn("LeaveGroup: " + groupId);

  //Ottengo il token di chi fa parte del mio gruppo escludendo me stesso
  pool.query('SELECT users.firebase_token FROM users INNER JOIN groups_users ON users.userid = groups_users.userid WHERE groups_users.groupid = ' + groupId + ' AND groups_users.userid <> ' + userId, (error, results) => {
    if (error) {
      console.log(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      if (results.rows.length > 0) { // Check inserito perchè se l'altro utente fa logout non riesco più ad abbandonare gruppo
        userToken = results.rows[0]['firebase_token']; // Valorizzo il token dell'altro utente che appartiene al gruppo
      }

      // Cancello tutte le entries che hanno il mio gruppo di appartenenza, e anche quelle
      // in cui è presente il mio utente in modo da pulire il DB in caso per errore faccia parte
      // di più gruppi contemporaneamente
      pool.query('DELETE FROM groups_users WHERE groupid = ' + groupId + ' OR userid = ' + userId,
        (error, results) => {
          if (error) {
            console.log(error);
            response.status(500).json({ message: 'errore query' })
          } else {
            if (!userToken) {
              // Non dovrebbe succedere perchè blocchiamo prima di confermare l'aggiunta a gruppo,
              // lascio comunque proseguire, ma l'altro utente non sarà notificato
              console.warn('LeaveGroup - Utente appartenente a gruppo non più abilitato a ricevere notifiche push');
            } else {
              // Genero le informazioni da inviare nella notifica
              const notificationMsgBody = {
                type: 'updateParams'
              };

              // Invio notifica
              sendNotification(userToken, "Gruppo sciolto",
                "Il gruppo di cui fai parte è stato sciolto",
                notificationMsgBody
              );
            }

            response.status(200).send();
          }
        });
    }
  });
};

// Restituisce la cena a cui partecipo
const getMyDinner = (request, response) => {
  console.log("getMyDinner - User: " + request.user.userid);

  pool.query('SELECT dinners.dinnerid AS id, dinners.dinner_title AS title, dinners.dinner_description AS description, dinners.dinner_type AS type, array_agg(DISTINCT dinners_detgroups.groupid) AS "groupIds", dinners.dinner_date AS date, dinners.dinner_administrator AS administrator, dinners.dinner_state AS state FROM dinners INNER JOIN dinners_detgroups ON dinners.dinnerid = dinners_detgroups.dinnerid INNER JOIN groups_users ON dinners_detgroups.groupid = groups_users.groupid WHERE dinner_date >= current_date AND dinner_state <> 6 AND dinner_state <> -1 GROUP BY dinners.dinnerid HAVING bool_or(groups_users.userid = ' + request.user.userid + ')', (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' });
    } else {
      response.status(200).json(results.rows[0]);
    }
  });
};

// Restituisce le cene disponibili nel raggio di MaxAvgDistance esclusa l'eventuale myDinner
const getOtherDinners = (request, response) => {
  console.log("getOtherDinners - User: " + request.user.userid);

  const myDinnerId = request.body.dinnerId;
  const index = request.body.index;
  const filter = request.body.filter;
  const otherDinners = [];
  const dinnersResponse = [];

  pool.query('SELECT dinners.dinnerid AS id, dinners.dinner_title AS title, dinners.dinner_description AS description, dinners.dinner_type AS type, array_agg(dinners_detgroups.groupid) AS "groupIds", dinners.dinner_date as date, dinners.dinner_administrator AS administrator, dinners.dinner_state AS state, array_agg(array[dinners_detgroups.groupid,users.address_lat,users.address_lon]) AS groups_coordinates FROM dinners INNER JOIN dinners_detgroups ON dinners.dinnerid = dinners_detgroups.dinnerid INNER JOIN groups_users ON dinners_detgroups.groupid = groups_users.groupid INNER JOIN users ON groups_users.userid = users.userid INNER JOIN groups_users AS gu ON gu.userid = users.userid WHERE dinner_state = 0 AND gu.house = true AND dinners.dinnerid <> ' + myDinnerId + ' AND CASE WHEN ' + filter + '<> 0 THEN dinners.dinner_type = ' + filter + ' ELSE TRUE END GROUP BY dinners.dinnerid, dinners.dinner_date ORDER BY dinner_date asc', (error, otherDinnersResults) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' });
    } else {
      if (otherDinnersResults.rows.length > 0) {

        // UserCoordinates, ottengo le coordinate di chi per me mette la casa: 
        // io se non sono in gruppo, l'owner della casa se sono in gruppo
        pool.query('SELECT users.name, users.address_lat as mylat, users.address_lon as mylon, gu_dinners.groupid, gu_dinners.name as ownername, gu_dinners.address_lat as grplat, gu_dinners.address_lon as grplon FROM users LEFT JOIN groups_users ON users.userid = groups_users.userid LEFT JOIN ( SELECT us.address_lat, us.address_lon, us.userid, us.name, gu.groupid, us.userid FROM groups_users AS gu INNER JOIN users as us ON gu.userid = us.userid WHERE house = true ) AS gu_dinners ON groups_users.groupid = gu_dinners.groupid WHERE users.userid = ' + request.user.userid,
          (error, userCoordsResult) => {
            if (error || userCoordsResult.rows.count == 0) {
              console.warn(error);
              response.status(500).json({ message: 'errore query' });
            } else {
              console.log(userCoordsResult.rows);
              let myLat = userCoordsResult.rows[0].grplat ? userCoordsResult.rows[0].grplat : userCoordsResult.rows[0].mylat;
              let myLon = userCoordsResult.rows[0].grplon ? userCoordsResult.rows[0].grplon : userCoordsResult.rows[0].mylon;

              let _dinnerGroupsLatLonObj = []; // Array di oggetti del tipo [groupId, latitude, longitude] di chi partecipa alla cena
              let _groupsTotalDistance = 0; // Distanza totale tra me e i partecipanti
              let _distance;
              let _mediaDistanze;

              console.log("myLat", myLat);
              console.log("myLon", myLon);
              for (var i = 0; i < otherDinnersResults.rows.length; i++) {
                _dinnerGroupsLatLonObj = otherDinnersResults.rows[i].groups_coordinates;

                // Calcolo distanza media tra me e i partecipanti alla cena
                _groupsTotalDistance = 0;
                for (var j = 0; j < _dinnerGroupsLatLonObj.length; j++) {
                  _distance = getDistanceFromLatLonInKm(_dinnerGroupsLatLonObj[j][1] || 0, _dinnerGroupsLatLonObj[j][2] || 1.2, myLat || 0, myLon || 0);
                  _groupsTotalDistance += _distance;
                }
                _mediaDistanze = _groupsTotalDistance / j;

                // Se la distanza è compatibile con il parametro aggiungo la cena all'elenco
                console.log("MEDIADIST", otherDinnersResults.rows[i].title, _mediaDistanze);
                if (_mediaDistanze < MaxAvgDistance) {
                  otherDinners.push(otherDinnersResults.rows[i]);
                }
              }

              // Decido, in base all'index ricevuto, quali cene ritornare
              if (index < otherDinners.length) {
                if (index + 10 < otherDinners.length) {
                  for (let i = index; i < index + 10; i++) {
                    dinnersResponse.push(otherDinners[i]);
                  }
                } else {
                  for (let i = index; i < otherDinners.length; i++) {
                    dinnersResponse.push(otherDinners[i]);
                  }
                }
              }

              // Ritorno le cene disponibili
              response.status(200).json(dinnersResponse);
            }
          });
      } else {
        // Ritorno oggetto vuoto
        response.status(200).json(otherDinnersResults.rows);
      }
    }
  });
};

// Restituisce lo state della cena
const getDinnerState = (request, res) => {
  const { dinnerId } = request.body;

  pool.query('SELECT dinner_state from dinners WHERE dinnerid = ' + dinnerId, (error, results) => {
    if (error) {
      console.log(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      res.json(results.rows[0]);
    }
  });
}

const getDinnerDetails = (request, response) => {
  const dinnerId = request.body.dinnerId;
  console.log("GetDinnerDetails - Dinner: " + dinnerId);
  const dinnerDetails = {};

  // 1 - Badges
  pool.query('SELECT groups_users.groupid, badges_detusers.badge_id, badges_detusers.progress, badges_detphase.badge_photo, badges_detphase.description FROM dinners_detgroups INNER JOIN groups_users ON groups_users.groupid = dinners_detgroups.groupid INNER JOIN badges_detusers ON badges_detusers.user_id = groups_users.userid INNER JOIN badges_detphase ON badges_detusers.badge_id = badges_detphase.badge_id AND badges_detusers.progress >= badges_detphase.min_progress AND badges_detusers.progress <= badges_detphase.max_progress WHERE dinners_detgroups.dinnerid = ' + dinnerId,
    (error, results) => {
      if (error) {
        console.warn(error);
        response.status(500).json({ message: 'errore query' })
      } else {
        dinnerDetails.badges = [];
        for (var i = 0; i < results.rows.length; i++) {
          const _badges = {
            group_id: results.rows[i].groupid,
            badge_id: results.rows[i].badge_id,
            badge_photo: results.rows[i].badge_photo,
            description: results.rows[i].description,
            progress: results.rows[i].progress
          }
          dinnerDetails.badges.push(_badges);
        }

        // 2 - FoodAllergies
        pool.query('SELECT groups_users.userid, allergies_detusers.allergy_id, allergies_detusers.allergy_name, food_allergies.category, food_allergies.allergy_photo FROM dinners_detgroups INNER JOIN groups_users ON groups_users.groupid = dinners_detgroups.groupid INNER JOIN allergies_detusers ON allergies_detusers.user_id = groups_users.userid INNER JOIN food_allergies ON food_allergies.allergy_id = allergies_detusers.allergy_id WHERE dinners_detgroups.dinnerid = ' + dinnerId + 'ORDER BY allergies_detusers.allergy_id',
          (error, results) => {
            if (error) {
              console.warn(error);
              response.status(500).json({ message: 'errore query' })
            } else {
              dinnerDetails.foodAllergies = [];
              for (var i = 0; i < results.rows.length; i++) {
                const _foodAllergies = {
                  user_id: results.rows[i].userid,
                  allergy_id: results.rows[i].allergy_id,
                  allergy_name: results.rows[i].allergy_name,
                  allergy_photo: results.rows[i].allergy_photo,
                  category: results.rows[i].category
                }
                dinnerDetails.foodAllergies.push(_foodAllergies);
              }

              // 3 - DinnerData
              pool.query('SELECT dinner_title as title, dinner_description as description, dinner_administrator AS administrator FROM dinners WHERE dinnerid = ' + dinnerId,
                (error, results) => {
                  if (error) {
                    console.warn(error);
                    response.status(500).json({ message: 'errore query' })
                  } else {

                    if (results.rows.length == 0) { // Se la cena non esiste più restituisco errore 404
                      response.status(404).json({ message: 'cena inesistente' });
                    } else {
                      dinnerDetails.dinnerData = results.rows[0];

                      // 4 - UsersData
                      pool.query('SELECT users.userid, users.birth_date, groups_users.groupid, gu.address as group_address FROM dinners_detgroups INNER JOIN groups_users ON groups_users.groupid = dinners_detgroups.groupid INNER JOIN users ON groups_users.userid = users.userid INNER JOIN (SELECT groups_users.groupid, users.address FROM users INNER JOIN groups_users ON users.userid = groups_users.userid WHERE groups_users.house = true) as GU ON gu.groupid = groups_users.groupid WHERE dinners_detgroups.dinnerid = ' + dinnerId + ' ORDER BY users.userid',
                        (error, results) => {
                          if (error) {
                            console.warn(error);
                            response.status(500).json({ message: 'errore query' });
                          } else {
                            dinnerDetails.usersData = [];
                            for (var i = 0; i < results.rows.length; i++) {
                              const _usersData = {
                                groupid: results.rows[i].groupid,
                                group_address: results.rows[i].group_address,
                                birth_date: results.rows[i].birth_date,
                              }
                              dinnerDetails.usersData.push(_usersData);
                            }
                            const userAddress = request.body.userAddress;
                            const userGroupId = request.body.userGroupId;
                            const otherUsersAddresses = []
                            const dinnerGroupIds = [];

                            // Creo array contenente i group_address degli altri partecipanti alla cena escluso lo user ed il suo partner
                            for (let k = 0; k < results.rows.length; k++) {
                              if (dinnerGroupIds.includes(results.rows[k].groupid) === false && results.rows[k].groupid !== userGroupId) {
                                otherUsersAddresses.push(results.rows[k].group_address);
                                dinnerGroupIds.push(results.rows[k].groupid);
                              };
                            };
                            calcDistance(userAddress, otherUsersAddresses).then(res => {
                              dinnerDetails.avgDistance = res
                              response.status(200).json(dinnerDetails);
                            },
                              () => { // Se errore nel calcolo delle distanze ritorno comunque esito positivo
                                console.log("Errore in calcDistance")
                                dinnerDetails.avgDistance = "Errore"
                                response.status(200).json(dinnerDetails);
                              });
                          }
                        });
                    }
                  }
                });
            }
          });
      }
    });
};

const getDinnerHouses = (request, res) => {
  const dinnerId = request.body.dinnerId;
  const groupId = request.body.groupId;

  const myDinnerDetails = {};

  // Ottengo le case e relative info facenti parte del path dell'utente (compresa la sua)
  pool.query("SELECT 'first' AS group_order, d1.groupid, d1.name, d1.userid, d1.profile_photo, gu.address FROM dinners_detpaths p1 INNER JOIN (SELECT dinners_detgroups.groupid, gu.userid, u.name, u.profile_photo FROM dinners_detgroups INNER JOIN groups_users gu on dinners_detgroups.groupid = gu.groupid INNER JOIN users u on gu.userid = u.userid WHERE dinners_detgroups.dinnerid = " + dinnerId + ") AS d1 ON d1.groupid = p1.first_group_house INNER JOIN (SELECT groups_users.groupid, users.address FROM users INNER JOIN groups_users ON users.userid = groups_users.userid WHERE groups_users.house = true) as GU ON gu.groupid = d1.groupid WHERE p1.dinnerid = " + dinnerId + " AND p1.groupid = " + groupId + " UNION ALL SELECT 'second' AS group_order, d2.groupid, d2.name, d2.userid, d2.profile_photo, gu.address FROM dinners_detpaths p1 INNER JOIN (SELECT dinners_detgroups.groupid, gu.userid, u.name, u.profile_photo FROM dinners_detgroups INNER JOIN groups_users gu on dinners_detgroups.groupid = gu.groupid INNER JOIN users u on gu.userid = u.userid WHERE dinners_detgroups.dinnerid = " + dinnerId + ") as d2 ON d2.groupid = p1.second_group_house INNER JOIN (SELECT groups_users.groupid, users.address FROM users INNER JOIN groups_users ON users.userid = groups_users.userid WHERE groups_users.house = true) as GU ON gu.groupid = d2.groupid WHERE p1.dinnerid = " + dinnerId + " AND p1.groupid = " + groupId + " UNION ALL SELECT 'third' AS group_order, d3.groupid, d3.name, d3.userid, d3.profile_photo, gu.address FROM dinners_detpaths p1 INNER JOIN (SELECT dinners_detgroups.groupid, gu.userid, u.name, u.profile_photo FROM dinners_detgroups INNER JOIN groups_users gu on dinners_detgroups.groupid = gu.groupid INNER JOIN users u on gu.userid = u.userid WHERE dinners_detgroups.dinnerid = " + dinnerId + ") as d3 ON d3.groupid = p1.third_group_house INNER JOIN (SELECT groups_users.groupid, users.address FROM users INNER JOIN groups_users ON users.userid = groups_users.userid WHERE groups_users.house = true) as GU ON gu.groupid = d3.groupid WHERE p1.dinnerid = " + dinnerId + " AND p1.groupid = " + groupId, (error, results) => {
    if (error) {
      console.log(error);
      res.status(500).json({ message: 'errore query' })
    } else {
      const dinnerHouses = {
        firstHouse: { groupid: null, firstUserId: null, firstName: "", secondUserId: null, secondName: "", firstImage: "", secondImage: "", groupAddress: "" },
        secondHouse: { groupid: null, firstUserId: null, firstName: "", secondUserId: null, secondName: "", firstImage: "", secondImage: "", groupAddress: "" },
        thirdHouse: { groupid: null, firstUserId: null, firstName: "", secondUserId: null, secondName: "", firstImage: "", secondImage: "", groupAddress: "" }
      }
      for (let i = 0; i < results.rows.length; i++) {
        if (results.rows[i].group_order === 'first') {
          if (!dinnerHouses.firstHouse.firstName) {
            dinnerHouses.firstHouse.firstUserId = results.rows[i].userid
            dinnerHouses.firstHouse.firstName = results.rows[i].name
            dinnerHouses.firstHouse.firstImage = results.rows[i].profile_photo
            dinnerHouses.firstHouse.groupAddress = results.rows[i].address
            dinnerHouses.firstHouse.groupid = results.rows[i].groupid
          } else {
            dinnerHouses.firstHouse.secondUserId = results.rows[i].userid
            dinnerHouses.firstHouse.secondName = results.rows[i].name
            dinnerHouses.firstHouse.secondImage = results.rows[i].profile_photo
          }
        } else if (results.rows[i].group_order === 'second') {
          if (!dinnerHouses.secondHouse.firstName) {
            dinnerHouses.secondHouse.firstUserId = results.rows[i].userid
            dinnerHouses.secondHouse.firstName = results.rows[i].name
            dinnerHouses.secondHouse.firstImage = results.rows[i].profile_photo
            dinnerHouses.secondHouse.groupAddress = results.rows[i].address
            dinnerHouses.secondHouse.groupid = results.rows[i].groupid
          } else {
            dinnerHouses.secondHouse.secondUserId = results.rows[i].userid
            dinnerHouses.secondHouse.secondName = results.rows[i].name
            dinnerHouses.secondHouse.secondImage = results.rows[i].profile_photo
          }
        } else if (results.rows[i].group_order === 'third') {
          if (!dinnerHouses.thirdHouse.firstName) {
            dinnerHouses.thirdHouse.firstUserId = results.rows[i].userid
            dinnerHouses.thirdHouse.firstName = results.rows[i].name
            dinnerHouses.thirdHouse.firstImage = results.rows[i].profile_photo
            dinnerHouses.thirdHouse.groupAddress = results.rows[i].address
            dinnerHouses.thirdHouse.groupid = results.rows[i].groupid
          } else {
            dinnerHouses.thirdHouse.secondUserId = results.rows[i].userid
            dinnerHouses.thirdHouse.secondName = results.rows[i].name
            dinnerHouses.thirdHouse.secondImage = results.rows[i].profile_photo
          }
        }
      }
      myDinnerDetails.dinnerHouses = dinnerHouses;

      // FoodAllergies di tutta la cena
      pool.query('SELECT groups_users.userid, allergies_detusers.allergy_id, allergies_detusers.allergy_name, food_allergies.category, food_allergies.allergy_photo FROM dinners_detgroups INNER JOIN groups_users ON groups_users.groupid = dinners_detgroups.groupid INNER JOIN allergies_detusers ON allergies_detusers.user_id = groups_users.userid INNER JOIN food_allergies ON food_allergies.allergy_id = allergies_detusers.allergy_id WHERE dinners_detgroups.dinnerid = ' + dinnerId + 'ORDER BY allergies_detusers.allergy_id',
        (error, results) => {
          if (error) {
            console.warn(error);
            response.status(500).json({ message: 'errore query' })
          } else {
            myDinnerDetails.foodAllergies = [];
            for (var i = 0; i < results.rows.length; i++) {
              const _foodAllergies = {
                user_id: results.rows[i].userid,
                allergy_id: results.rows[i].allergy_id,
                allergy_name: results.rows[i].allergy_name,
                allergy_photo: results.rows[i].allergy_photo,
                category: results.rows[i].category
              }
              myDinnerDetails.foodAllergies.push(_foodAllergies);
            }

            res.status(200).json(myDinnerDetails);
          }
        });
    }
  });
}

// Ottengo i vincitori della cena
const getDinnerWinners = (request, response) => {
  const { dinnerId } = request.body;
  console.log("GetDinnerWinners - Dinner: " + dinnerId);
  const dinnerWinners = [];

  pool.query('SELECT dw.badgeid, dw.userid, dw.has_voted, dw.groupid, users.name, users.profile_photo, dw.vote, badges.badge_photo, dinners_types_badges.category FROM dinners_detwinners AS dw INNER JOIN badges ON dw.badgeid = badges.badge_id INNER JOIN dinners ON dinners.dinnerid = ' + dinnerId + ' INNER JOIN dinners_types_badges ON dinners_types_badges.dinner_type = dinners.dinner_type AND dinners_types_badges.badgeid = dw.badgeid INNER JOIN users ON users.userid = dw.userid WHERE dw.dinnerid = ' + dinnerId,
    (error, results) => {
      if (error) {
        console.warn(error);
        response.status(500).json({ message: 'errore query' });
      } else {
        for (var i = 0; i < results.rows.length; i++) {
          const _usersData = {
            userId: results.rows[i].userid,
            name: results.rows[i].name,
            profile_photo: results.rows[i].profile_photo,
            groupId: results.rows[i].groupid,
            badgeId: results.rows[i].badgeid,
            badge_photo: results.rows[i].badge_photo,
            category: results.rows[i].category,
            vote: results.rows[i].vote,
            has_voted: results.rows[i].has_voted
          }
          dinnerWinners.push(_usersData);
        }

        response.status(200).json(dinnerWinners);
      }
    });
};

// Ottengo le cene passate dell'utente
const getDinnerHistory = (request, response) => {
  const userId = request.user.userid;
  console.log("GetDinnerHistory - User: " + userId);

  pool.query('SELECT d.dinnerid AS id, d.dinner_title AS title, d.dinner_description AS description, d.dinner_date AS date, d.dinner_type AS type, d.dinner_state AS state FROM dinner_history AS dh INNER JOIN dinners AS d ON d.dinnerid = dh.dinnerid WHERE dh.userid = ' + userId,
    (error, results) => {
      if (error) {
        console.warn(error);
        response.status(500).json({ message: 'errore query' });
      } else {
        response.status(200).json(results.rows);
      }
    });
};

const insertDinnerVotes = (request, response) => {
  const { groupsArray, votingGroupId, dinnerId } = request.body;
  const votingUserId = request.user.userid;

  console.log("Insert Dinner Votes - dinnerId: " + dinnerId);

  groupsArray.forEach(x => {
    for (let i = 0; i < x.userIds.length; i++) {
      // Valorizzo le costanti con i valori relativi al gruppo
      const groupId = x.votes.groupId;
      const userId = x.userIds[i];
      const firstCatVote = x.votes.firstCategory;
      const secondCatVote = x.votes.secondCategory;
      const thirdCatVote = x.votes.thirdCategory;
      const fourthCatVote = x.votes.fourthCategory;
      const fifthCatVote = x.votes.fifthCategory;

      // Inserisco i voti nella tabella controllando se è gia presente un elemento, in tal caso faccio la media (se sono già presenti dei voti) oppure inserisco i voti se null (ovvero la riga è presente perchè ha votato)
      pool.query('INSERT INTO dinners_detvotes (dinnerid, groupid, userid, firstcat_avg, secondcat_avg, thirdcat_avg, fourthcat_avg, fifthcat_avg) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (dinnerid, groupid, userid) DO UPDATE SET firstcat_avg = CASE WHEN dinners_detvotes.firstcat_avg IS NULL THEN $4 ELSE ((dinners_detvotes.firstcat_avg + excluded.firstcat_avg) / 2) END, secondcat_avg = CASE WHEN dinners_detvotes.secondcat_avg IS NULL THEN $5 ELSE (dinners_detvotes.secondcat_avg + excluded.secondcat_avg) / 2 END, thirdcat_avg = CASE WHEN dinners_detvotes.thirdcat_avg IS NULL THEN $6 ELSE (dinners_detvotes.thirdcat_avg + excluded.thirdcat_avg) / 2 END, fourthcat_avg = CASE WHEN dinners_detvotes.fourthcat_avg IS NULL THEN $7 ELSE (dinners_detvotes.fourthcat_avg + excluded.fourthcat_avg) / 2 END, fifthcat_avg = CASE WHEN dinners_detvotes.fifthcat_avg IS NULL THEN $8 ELSE (dinners_detvotes.fifthcat_avg + excluded.fifthcat_avg) / 2 END',
        [dinnerId, groupId, userId, firstCatVote, secondCatVote, thirdCatVote, fourthCatVote, fifthCatVote], (err) => {
          if (err) {
            console.warn(err);
            response.status(500).json({ message: 'errore query' })
          }
        });
    }
  })

  // Inserisco riga relativa al votante comprendente il suo groupId, userId e il flag 'true' che indica che ha votato
  pool.query('INSERT INTO dinners_detvotes (dinnerid, groupid, userid, has_voted) VALUES ($1, $2, $3, $4) ON CONFLICT (dinnerid, groupid, userid) DO UPDATE SET userid = excluded.userid, groupid = excluded.groupid, dinnerid = excluded.dinnerid, has_voted = $4',
    [dinnerId, votingGroupId, votingUserId, 'true'], (err) => {
      if (err) {
        console.warn(err);
        response.status(500).json({ message: 'errore query' })
      } else {
        console.log("Voti correttamente aggiunti")
        response.status(200).send();
      }
    });
}

// Controllo se l'utente ha già votato o meno
const checkIfVoted = (request, res) => {
  const { dinnerId } = request.body;
  const userId = request.user.userid;

  // Controllo se presente l'userId dell'utente associato a flag true nel campo hasVoted
  pool.query('SELECT * FROM dinners_detvotes WHERE dinnerid = ' + dinnerId + ' AND userid = ' + userId + ' AND has_voted = true', (error, results) => {
    if (error) {
      console.log(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      if (results.rows.length === 0) {
        res.json({ hasVoted: false });
      } else {
        res.json({ hasVoted: true });
      }
    }
  });
}

const createDinner = (request, response) => {
  const { dinnerTitle, dinnerDescription, dinnerType, dinnerDate, groupId } = request.body;
  const userId = request.user.userid;
  const dinnerId = Math.floor(Math.random() * (100000 - 1)) + 1; // Genero dinnerId random per averlo subito invece che farlo generare al DB
  var userToken;

  console.log("Create dinner - dinnerId: " + dinnerId);

  //Ottengo il token di chi fa parte del mio gruppo escludendo me stesso
  pool.query('SELECT users.firebase_token FROM users INNER JOIN groups_users ON users.userid = groups_users.userid WHERE groups_users.groupid = ' + groupId + ' AND groups_users.userid <> ' + userId,
    (error, results) => {
      if (error) {
        console.log(error);
        response.status(500).json({ message: 'errore query' })
      } else {
        if (results.rows.length > 0) { //Check inserito perchè se l'altro utente fa logout non riesco più a creare la cena
          userToken = results.rows[0]['firebase_token']; //Valorizzo il token dell'altro utente che appartiene al gruppo
        }
      }
    });

  // Gestione inserimento doppio in transazione con eventuale rollback se qualcosa fallisce
  pool.query('BEGIN', function (err) {
    if (err) {
      return rollback(pool, response, err);
    }
    // Creo la cena
    pool.query('INSERT INTO dinners (dinnerid, dinner_type, dinner_date, dinner_description, dinner_title, dinner_administrator) VALUES ($1, $2, $3, $4, $5, $6)',
      [dinnerId, dinnerType, dinnerDate, dinnerDescription, dinnerTitle, groupId], (err) => {
        if (err) return rollback(pool, response, err);

        // Aggiungo il gruppo come primo partecipante della cena
        pool.query('INSERT INTO dinners_detgroups (dinnerid, groupid) VALUES ($1, $2)',
          [dinnerId, groupId], (err) => {
            if (err) return rollback(pool, response, err);

            pool.query('COMMIT', function () {
              if (userToken) { // Verifico che l'altro utente del gruppo abbia un token valido per inviargli la notifica
                // Genero le informazioni da inviare nella notifica
                const notificationMsgBody = {
                  type: 'updateParams'
                };

                // Invio notifica
                sendNotification(userToken, "Creazione cena",
                  "Una nuova RunningDinner è stata creata",
                  notificationMsgBody
                );
              }

              response.status(201).send();
            });
          });
      });
  });
};

const leaveDinner = (request, response) => {
  const { groupId, dinnerId } = request.body;
  const userId = request.user.userid;
  var groupUserToken = null; //Token dell'altro utente del mio gruppo

  // Invia notifica all'altro partecipante al gruppo
  const sendLeaveDinnerNotificationToGroup = function (userToken) {
    if (!userToken) {
      // L'altro utente non sarà notificato della rimozione dalla cena
      console.warn('LeaveDinner - Utente appartenente a gruppo non più abilitato a ricevere notifiche push');
    } else {
      // Genero le informazioni da inviare nella notifica
      const notificationMsgBody = {
        type: 'updateParams'
      };
      // Invio notifica
      sendNotification(userToken, "Cena abbandonata",
        "Il tuo gruppo ha abbandonato la cena a cui partecipavi",
        notificationMsgBody
      );
    }
  };

  // Invia notifica ai nuovi amministratori della cena
  const sendLeaveDinnerNotificationToNewAdministrators = function (userTokens) {
    if (!userTokens.length) {
      // L'altro gruppo non verrà notificato di essere il nuovo admin
      console.warn('LeaveDinner - Utenti appartenente a nuovo gruppo amministratore non abilitati a ricevere notifiche push');
    } else {
      // Genero le informazioni da inviare nella notifica
      const notificationMsgBody = {
        type: 'updateParams'
      };

      // Invio notifiche
      sendNotification(userTokens, "Cena modificata",
        "Sei il nuovo amministratore della cena a cui partecipi",
        notificationMsgBody
      );
    }
  };

  console.log("[LeaveDinner] GroupId: " + groupId + " , DinnerId: " + dinnerId);

  //Ottengo il token di chi fa parte del mio gruppo escludendo me stesso
  pool.query('SELECT users.firebase_token FROM users INNER JOIN groups_users ON users.userid = groups_users.userid WHERE groups_users.groupid = ' + groupId + ' AND groups_users.userid <> ' + userId, (error, results) => {
    if (error) {
      console.log(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      if (results.rows.length > 0) { // Check inserito perchè se l'altro utente fa logout non riesco più ad abbandonare la cena
        groupUserToken = results.rows[0]['firebase_token']; // Valorizzo il token dell'altro utente che appartiene al gruppo
      }

      // Ottengo gli altri gruppi partecipanti alla cena
      pool.query('SELECT * FROM dinners_detgroups WHERE dinners_detgroups.dinnerid = ' + dinnerId + ' AND dinners_detgroups.groupid <> ' + groupId, (error, results) => {
        if (error) {
          console.log(error);
          response.status(500).json({ message: 'errore query' })
        } else {
          pool.query('BEGIN', function (err) {
            if (err) return rollback(pool, response, err);

            // Rimuovo il mio gruppo dalla cena
            pool.query('DELETE FROM dinners_detgroups WHERE groupid = ' + groupId,
              (error) => {
                if (error) return rollback(pool, response, error);

                if (results.rows.length == 0) { // Il mio gruppo era l'unico partecipante alla cena, cancello il mio gruppo e la cena
                  console.log("Un gruppo solo, cancello cena");

                  // Cancello la cena
                  pool.query('DELETE FROM dinners WHERE dinnerid = ' + dinnerId,
                    (error) => {
                      if (error) return rollback(pool, response, error);

                      sendLeaveDinnerNotificationToGroup(groupUserToken);

                      pool.query('COMMIT', function () {
                        response.status(200).send();
                      });
                    });
                } else { // Vi sono altri gruppi oltre al mio che partecipano

                  pool.query('SELECT dinner_administrator FROM dinners WHERE dinnerid = ' + dinnerId, (error, results) => {
                    if (results.rows[0]['dinner_administrator'] == groupId) {
                      console.log("Più gruppi e sono amministratore, eleggo nuovo amministratore cena");

                      // Seleziono il nuovo gruppo amministratore della cena prendendo il primo altro gruppo in tabella (dovrebbe essere in ordine di inserimento)
                      pool.query('UPDATE dinners SET dinner_administrator = (select groupid FROM dinners_detgroups WHERE dinnerid = ' + dinnerId + ' fetch first 1 rows only) WHERE dinnerid = ' + dinnerId,
                        (error) => {
                          if (error) return rollback(pool, response, error);

                          sendLeaveDinnerNotificationToGroup(groupUserToken);

                          // Ottengo i token dei nuovi amministratori della cena
                          pool.query('SELECT users.firebase_token, users.name ' + ' FROM users INNER JOIN groups_users ON (users.userid = groups_users.userid) ' + ' INNER JOIN dinners ON (dinners.dinner_administrator = groups_users.groupid) ' + ' WHERE dinners.dinnerid = ' + dinnerId + ' AND users.firebase_token IS NOT NULL AND users.firebase_token <> \'\' ',
                            (error, res) => {
                              const userTokens = [];
                              for (var i = 0; i < res.rows.length; i++) {
                                if (res.rows[i]['firebase_token']) {
                                  userTokens.push(res.rows[i]['firebase_token']);
                                }
                              }

                              sendLeaveDinnerNotificationToNewAdministrators(userTokens);

                              pool.query('COMMIT', function () {
                                response.status(200).send();
                              });
                            });
                        });
                    } else {
                      console.log("Leave Dinner - Più gruppi e non sono amministratore, abbandono semplicemente");

                      sendLeaveDinnerNotificationToGroup(groupUserToken);

                      pool.query('COMMIT', function () {
                        response.status(200).send();
                      });
                    }

                  });
                }
              });
          });
        }
      });
    }
  });
};

const joinDinner = (request, response) => {
  const { groupId, dinnerId } = request.body;
  const userId = request.user.userid;
  var userToken = null; //Token dell'altro utente del mio gruppo

  console.log("[JoinDinner] GroupId: " + groupId + " , DinnerId: " + dinnerId);

  //Ottengo il token di chi fa parte del mio gruppo escludendo me stesso
  pool.query('SELECT users.firebase_token FROM users INNER JOIN groups_users ON users.userid = groups_users.userid WHERE groups_users.groupid = ' + groupId + ' AND groups_users.userid <> ' + userId,
    (error, results) => {
      if (error) {
        console.log(error);
        response.status(500).json({ message: 'errore query' })
      } else {
        if (results.rows.length > 0) { //Check inserito perchè se l'altro utente fa logout non riesco più a creare la cena
          userToken = results.rows[0]['firebase_token']; //Valorizzo il token dell'altro utente che appartiene al gruppo
        }

        // Aggiungo il gruppo alla cena
        pool.query('INSERT INTO dinners_detgroups (dinnerid, groupid) VALUES ($1, $2)',
          [dinnerId, groupId], (err) => {

            if (!userToken) {
              // L'altro utente non sarà notificato della rimozione dalla cena
              console.warn('JoinDinner - Utente appartenente a gruppo non più abilitato a ricevere notifiche push');
            } else {
              // Genero le informazioni da inviare nella notifica
              const notificationMsgBody = {
                type: 'updateParams'
              };
              // Invio notifica
              sendNotification(userToken, "Cena abbandonata",
                "Il tuo gruppo ha abbandonato la cena a cui partecipavi",
                notificationMsgBody
              );
            }

            response.status(201).send();
          });
      }
    });
};

const updateDinner = (request, response) => {
  const { dinnerId, title, description } = request.body;
  const userId = request.user.userid;

  // Aggiorno informazioni sulla cena
  pool.query('UPDATE dinners SET dinner_title = $1, dinner_description = $2 WHERE dinnerid = $3', [title, description, dinnerId],
    (error, results) => {
      if (error) {
        console.warn(error);
        response.status(500).json({ message: 'errore query' })
      } else {
        // Ottengo l'elenco dei token dei partecipanti alla cena a parte me
        pool.query('SELECT users.firebase_token, users.name FROM users INNER JOIN groups_users ON (users.userid = groups_users.userid) INNER JOIN dinners_detgroups ON groups_users.groupid = dinners_detgroups.groupid WHERE dinnerid = ' + dinnerId + ' AND users.firebase_token IS NOT NULL AND users.firebase_token <> \'\' AND users.userid <> ' + userId,
          (error, results) => {
            const userTokens = [];
            for (var i = 0; i < results.rows.length; i++) {
              if (results.rows[i]['firebase_token']) {
                userTokens.push(results.rows[i]['firebase_token']);
              }
            }

            // Genero le informazioni da inviare nella notifica
            const notificationMsgBody = {
              type: 'updateParams'
            };

            // Invio notifiche
            if (userTokens.length) {
              sendNotification(userTokens, "Cena modificata",
                "La cena a cui partecipi è stata modificata",
                notificationMsgBody
              );
            } else {
              console.log("Update Dinner - Nessuno verrà notificato per la modifica alla cena");
            }

            response.status(200).send();
          });
      }
    });
};

const sendNewMessageNotification = (request, response) => {
  const { dinnerId } = request.body;
  const userId = request.user.userid;
  const userName = request.user.name;

  // Ottengo l'elenco dei token dei partecipanti alla cena a parte me
  pool.query('SELECT users.firebase_token, users.name FROM users INNER JOIN groups_users ON (users.userid = groups_users.userid) INNER JOIN dinners_detgroups ON groups_users.groupid = dinners_detgroups.groupid WHERE dinnerid = ' + dinnerId + ' AND users.firebase_token IS NOT NULL AND users.firebase_token <> \'\' AND users.userid <> ' + userId,
    (error, results) => {
      const userTokens = [];
      for (var i = 0; i < results.rows.length; i++) {
        if (results.rows[i]['firebase_token']) {
          userTokens.push(results.rows[i]['firebase_token']);
        }
      }

      // Genero le informazioni da inviare nella notifica
      const notificationMsgBody = {
        type: 'newMessage'
      };

      // Invio notifiche
      if (userTokens.length) {
        sendNotification(userTokens, "Nuovo messaggio",
          userName + " ha inviato un nuovo messaggio in chat",
          notificationMsgBody
        );
      } else {
        console.log("sendNewMessageNotification - Nessuno verrà notificato per l'invio del nuovo messaggio");
      }

      response.status(200).send();
    });
};

const runQuery = (request, response) => {
  const query = request.body.query;

  console.warn("RunQuery: " + query);

  if (query) {
    pool.query(query, (error, results) => {
      if (error) {
        console.warn(error);
        response.status(500).json({ message: 'errore query' })
      } else {
        console.warn("Results: " + JSON.stringify(results.rows));
        response.status(200).json(results.rows);
      }
    }
    );
  } else {
    console.warn('Empty query');
    response.status(400).json("Empty query");
  }
};

//--------Routes Definition-------//

//Users
app
  .route('/users')
  .get(authenticateJWT, getUsers) //[Non utilizzare] GET endpoint to list Users
  .post(addUser) // POST endpoint to signup user

//UpdateUser
app
  .route('/updateUser')
  .post(authenticateJWT, updateUser)

//ExistsUser
app
  .route('/existsUser')
  .post(checkUserExists)

//GetUserBadges
app
  .route('/getUserBadges')
  .post(authenticateJWT, getUserBadges)

//InsertUserBadge (non utilizzata)
app
  .route('/insertUserBadge')
  .post(authenticateJWT, insertUserBadge)

//GetPartnerBadges
app
  .route('/getPartnerBadges')
  .post(authenticateJWT, getPartnerBadges)

//GetContactBadges
app
  .route('/getContactBadges')
  .post(authenticateJWT, getContactBadges)

//GetFoodAllergies
app
  .route('/getFoodAllergies')
  .get(authenticateJWT, getFoodAllergies)

//GetUserFoodAllergies
app
  .route('/getUserFoodAllergies')
  .post(getUserFoodAllergies)

//GetPartnerFoodAllergies
app
  .route('/getPartnerFoodAllergies')
  .post(getPartnerFoodAllergies)

//UpdateFoodAllergies
app
  .route('/insertFoodAllergies')
  .post(authenticateJWT, insertFoodAllergies)

//DeleteFoodAllergies
app
  .route('/deleteFoodAllergies')
  .post(authenticateJWT, deleteFoodAllergies)

//Login
app.post('/login', login);

//Logout
app
  .route('/logout')
  .post(logout)

//RefreshToken
app.post('/refreshToken', refreshToken);

//Params
app
  .route('/params')
  .get(authenticateJWT, getParams)

//CompareContacts
app
  .route('/compareContacts')
  .post(authenticateJWT, compareContacts);

//InviteGroup
app
  .route('/inviteGroup')
  .post(authenticateJWT, inviteGroup);

//InviteGroupConfirm
app
  .route('/inviteGroupConfirm')
  .post(authenticateJWT, inviteGroupConfirm);

//getGroupPartner
app
  .route('/getGroupPartner')
  .post(authenticateJWT, getGroupPartner);

//LeaveGroup
app
  .route('/leaveGroup')
  .post(authenticateJWT, leaveGroup);

//UpdateFirebaseToken
app
  .route('/updateFirebaseToken')
  .post(authenticateJWT, updateFirebaseToken);

//Dinners
app
  .route('/dinners')
  .post(authenticateJWT, createDinner) // POST endpoint to create dinner
  .put(authenticateJWT, updateDinner) // PUT endpoint to update dinner

//myDinner
app
  .route('/getMyDinner')
  .get(authenticateJWT, getMyDinner)

//otherDinners
app
  .route('/getOtherDinners')
  .post(authenticateJWT, getOtherDinners)

//Dinner state
app
  .route('/getDinnerState')
  .post(authenticateJWT, getDinnerState)

//Dinner details
app
  .route('/getDinnerDetails')
  .post(authenticateJWT, getDinnerDetails)

//Dinner houses
app
  .route('/getDinnerHouses')
  .post(authenticateJWT, getDinnerHouses)

// Dinner Winners
app
  .route('/getDinnerWinners')
  .post(authenticateJWT, getDinnerWinners)

// Dinner History
app
  .route('/getDinnerHistory')
  .get(authenticateJWT, getDinnerHistory)

// Dinner votes
app
  .route('/insertDinnerVotes')
  .post(authenticateJWT, insertDinnerVotes)

// Dinner hasVoted
app
  .route('/checkIfVoted')
  .post(authenticateJWT, checkIfVoted)

//Leaver dinner
app
  .route('/leaveDinner')
  .post(authenticateJWT, leaveDinner)

//Join dinner
app
  .route('/joinDinner')
  .post(authenticateJWT, joinDinner)

//Send new message notification
app
  .route('/sendNewMessageNotification')
  .post(authenticateJWT, sendNewMessageNotification)

//RunQuery
app
  .route('/runQuery')
  .post(authenticateJWT, runQuery);

//--------Run--------//

// Start Server
app.listen(process.env.PORT || 1111, () => {
  console.log(`Server listening`)
})

// Gestione elaborazione cene
elaboraCene();
elaboraFasi();
elaboraVoti();
const intervalObj = setInterval(() => {
  elaboraCene();
  elaboraFasi();
  elaboraVoti();
}, ElaboraCeneInterval);