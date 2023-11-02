#!/bin/bash

threadPerformanceFilepath="$1"
cypressConfigFilepath="$3"
thread="$4"
threadNo="$5"
allureResultsPath="$2/$threadNo"
additionalCypressEnvArgs="$6"

start=$SECONDS

cypress run --config-file "$cypressConfigFilepath" --e2e --config="$thread" --env allureResultsPath="$allureResultsPath""$additionalCypressEnvArgs"

timeTaken=$((SECONDS - start))

echo "$threadNo,$timeTaken" >>"$threadPerformanceFilepath" # record the length of time it took for the thread to complete

echo Thread \#"$threadNo" has completed.
