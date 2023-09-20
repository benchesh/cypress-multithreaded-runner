#!/bin/bash

openNewThread() {
    threadPerfPath="$1"
    allureResultsPath="$2"
    configFile="$3"
    configObj="$4"
    thread="$5"

    start=$SECONDS

    cypress run --config-file "$configFile" --e2e --config="$configObj" --env allureResultsPath="$allureResultsPath"

    timeTaken=$((SECONDS - start))
    echo "$thread,$timeTaken" >>"$threadPerfPath" # record the length of time it took for the thread to complete
}

threadNo=1

if [[ $7 == "" ]]; then # not multithreaded
    openNewThread "$1" "$2" "$3" "$6" $threadNo
else
    waitForFileTimeout=$5
    waitForFileTimeoutOG=$5

    for configObj in "${@:6}"; do                                       # additional threads will be passed as additional args
        openNewThread "$1" "$2/$threadNo" "$3" "$configObj" $threadNo & # the threadNo is appended to the 2nd arg as this allows for more granular reporting
        sleep 10                                                        # wait a few seconds as it doesn't like opening multiple threads all at once
        ((threadNo++))                                                  # changing the thread number allows us to report on the performance of each thread

        # if [[ $4 != "" ]]; then
        #     while [ ! -f "$4" ] || [[ $(cat "$4") == "" ]] && ((waitForFileTimeout > 0)); do # wait for the file to exist
        #         sleep 1
        #         ((waitForFileTimeout--))

        #         if ((waitForFileTimeout == 0)); then
        #             echo "WARNING: There may be an issue as the $4 file hasn't been created after $waitForFileTimeoutOG seconds... will continue anyway!"
        #         fi
        #     done
        # fi
    done

    wait # wait for all threads to complete
fi

echo All Cypress testing threads have ended.
