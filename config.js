require('dotenv').config()

const { Pool } = require('pg')
const isProduction = false; //process.env.NODE_ENV === 'production' //In developmente è false

const connectionString = `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_DATABASE}?ssl=true`

if(isProduction){
  console.warn("PRODUCTION");
}

const pool = new Pool({
  connectionString: connectionString, //isProduction ? process.env.DATABASE_URL : connectionString, Da modificare per utilizzare la variabile d'ambiente su Heroku, ora non funziona
  ssl: isProduction,
})

module.exports = { pool }